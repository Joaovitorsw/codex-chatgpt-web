const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { getEventListeners } = require("node:events");
const { runBrowserHelperOperation } = require("../electron/browser-helper-verifier.cjs");

function fixture(context, behavior = 'send({ type: "result", id: message.id, value: { referenceCount: 1 } });') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-helper-references-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  const stopped = path.join(root, "stopped");
  const image = path.join(root, "reference.png");
  fs.writeFileSync(image, Buffer.from("89504e470d0a1a0a00000000", "hex"));
  fs.writeFileSync(script, `
    const fs = require("node:fs");
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    const input = require("node:readline").createInterface({ input: process.stdin });
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") {
        fs.writeFileSync(${JSON.stringify(stopped)}, "stopped");
        setTimeout(() => process.exit(0), 30);
        return;
      }
      fs.writeFileSync(${JSON.stringify(path.join(root, "request.json"))}, JSON.stringify(message));
      ${behavior}
    });
  `);
  return {
    root, stopped,
    options: {
      helper: { executable: process.execPath, script },
      descriptorPath: "/runtime/launcher-browser.json",
      appName: "Codex Native2",
      operation: "image_references",
      payload: { targetId: "ABC123-CDP-TARGET", referenceImagePaths: [image] },
    },
  };
}

test("image references forwards the CDP target and files with protected protocol fields and a 120-second deadline", async context => {
  const { root, stopped, options } = fixture(context);
  const delays = [];
  const originalSetTimeout = global.setTimeout;
  context.mock.method(global, "setTimeout", (callback, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  });
  Object.assign(options.payload, { type: "smoke", id: "spoofed", config: { appName: "other" } });
  const result = await runBrowserHelperOperation(options);
  const request = JSON.parse(fs.readFileSync(path.join(root, "request.json"), "utf8"));
  assert.equal(request.type, "image_references");
  assert.match(request.id, /^image_references-[a-f0-9]{24}$/);
  assert.equal(request.targetId, options.payload.targetId);
  assert.deepEqual(request.referenceImagePaths, options.payload.referenceImagePaths);
  assert.deepEqual(request.config, {
    appName: options.appName, browserHostDescriptorPath: options.descriptorPath, useSavedChats: false,
  });
  assert.deepEqual(result, { type: "result", id: request.id, value: { referenceCount: 1 } });
  assert.ok(delays.includes(120_000));
  assert.ok(fs.existsSync(stopped));
});

test("image references preserves the upload-side reference count", async context => {
  const { options } = fixture(context, 'send({ type: "result", id: message.id, value: { referenceCount: 0 } });');
  assert.equal((await runBrowserHelperOperation(options)).value.referenceCount, 0);
});

test("image references rejects a response for a different request and stops the helper", async context => {
  const { options, stopped } = fixture(context, 'send({ type: "result", id: "wrong", value: { referenceCount: 1 } });');
  await assert.rejects(runBrowserHelperOperation(options), error => {
    assert.match(error.message, /response identity is invalid/);
    assert.match(error.operationId, /^image_references-/);
    return true;
  });
  assert.ok(fs.existsSync(stopped));
});

test("image references rejects invalid payloads before spawning a helper", async context => {
  const { options, root } = fixture(context);
  const invalidPayloads = [null, {}, { targetId: "", referenceImagePaths: options.payload.referenceImagePaths },
    { targetId: "   ", referenceImagePaths: options.payload.referenceImagePaths },
    { targetId: 42, referenceImagePaths: options.payload.referenceImagePaths },
    { targetId: "target", referenceImagePaths: [] }, { targetId: "target", referenceImagePaths: ["relative.png"] },
    { targetId: "target", referenceImagePaths: "image.png" }];
  await Promise.all(invalidPayloads.map(payload => assert.rejects(
    runBrowserHelperOperation({ ...options, payload }), /image reference/i,
  )));
  assert.equal(fs.existsSync(path.join(root, "request.json")), false);
});

test("an already aborted operation never starts a helper", async context => {
  const { options, root } = fixture(context);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runBrowserHelperOperation({ ...options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(path.join(root, "request.json")), false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("disconnect abort stops the helper and removes its listener", async context => {
  const { options, stopped } = fixture(context, 'process.stderr.write("waiting\\n");');
  const controller = new AbortController();
  options.logger = { info() { controller.abort(); } };
  await assert.rejects(runBrowserHelperOperation({ ...options, signal: controller.signal }), error => {
    assert.equal(error.name, "AbortError");
    assert.match(error.operationId, /^image_references-/);
    return true;
  });
  assert.ok(fs.existsSync(stopped));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abort racing with result cleanup cannot return success", async context => {
  const { options } = fixture(context);
  const controller = new AbortController();
  const originalSetTimeout = global.setTimeout;
  context.mock.method(global, "setTimeout", (callback, delay, ...args) => {
    // The shutdown wait starts only after a successful result has arrived.
    if (delay === 5_000) controller.abort();
    return originalSetTimeout(callback, delay, ...args);
  });
  await assert.rejects(runBrowserHelperOperation({ ...options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("successful operations remove the abort listener", async context => {
  const { options } = fixture(context);
  const controller = new AbortController();
  await runBrowserHelperOperation({ ...options, signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("helper errors retain their class and request id and remove the abort listener", async context => {
  const { options, stopped } = fixture(context,
    'send({ type: "error", id: message.id, name: "ImageReferenceUploadError", message: "upload failed" });');
  const controller = new AbortController();
  await assert.rejects(runBrowserHelperOperation({ ...options, signal: controller.signal }), error => {
    assert.equal(error.name, "ImageReferenceUploadError");
    assert.equal(error.message, "upload failed");
    assert.match(error.operationId, /^image_references-[a-f0-9]{24}$/);
    return true;
  });
  assert.ok(fs.existsSync(stopped));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
