import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

async function fixture(run: (io: {
  send: (value: unknown) => void;
  next: () => Promise<Record<string, unknown>>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "image-reference-protocol-"));
  const script = join(directory, "helper.ts");
  const uploadPath = new URL("../src/adapters/chatgpt-web/image-reference-upload.ts", import.meta.url).href;
  const workerPath = new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href;
  const mainPath = new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href;
  await writeFile(script, `
    import { mock } from 'bun:test';
    mock.module(${JSON.stringify(uploadPath)}, () => ({
      uploadImageReferences: async options => {
        process.stdout.write(JSON.stringify({type:'fixture_upload_started', targetId:options.targetId})+'\\n');
        if (options.referenceImagePaths[0] === 'pending') {
          await new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
          });
        }
        return {referenceCount: options.referenceImagePaths.length};
      }
    }));
    const { ChatGptBrowserWorker } = await import(${JSON.stringify(workerPath)});
    ChatGptBrowserWorker.forProvider = () => {throw new Error('image references accessed worker');};
    await import(${JSON.stringify(mainPath)});
  `);
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += String(data); });
  const io = {
    send: (value: unknown) => { child.stdin.write(JSON.stringify(value) + "\n"); },
    next: async () => {
      const result = await lines.next();
      if (result.done) throw new Error(`Helper exited: ${diagnostics}`);
      return JSON.parse(result.value) as Record<string, unknown>;
    },
  };
  try {
    expect((await io.next()).type).toBe("ready");
    await run(io);
  } finally {
    io.send({ type: "shutdown" });
    const timer = setTimeout(() => child.kill(), 2000);
    await exit;
    clearTimeout(timer);
    output.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const config = { appName: "Fixture", browserHostDescriptorPath: "fixture-descriptor" };

test("image references maintenance forwards target and returns count without a worker", async () => {
  await fixture(async io => {
    io.send({ type: "image_references", id: "fixture-success", config, targetId: "exact-cdp-target", referenceImagePaths: ["one", "two"] });
    expect(await io.next()).toEqual({ type: "fixture_upload_started", targetId: "exact-cdp-target" });
    expect(await io.next()).toEqual({ type: "result", id: "fixture-success", value: { referenceCount: 2 } });
  });
});

test("image references maintenance rejects invalid protocol identity before upload", async () => {
  await fixture(async io => {
    io.send({ type: "image_references", id: "bad", config, targetId: "target", referenceImagePaths: ["one"] });
    const error = await io.next();
    expect(error.type).toBe("error");
    expect(error.message).toBe("Browser helper maintenance identity is invalid");
  });
});

test("image references maintenance consumes abort and releases the operation id", async () => {
  await fixture(async io => {
    const message = { type: "image_references", id: "fixture-abort", config, targetId: "target", referenceImagePaths: ["pending"] };
    io.send(message);
    expect((await io.next()).type).toBe("fixture_upload_started");
    io.send({ type: "abort", id: message.id });
    const error = await io.next();
    expect(error.type).toBe("error");
    expect(error.name).toBe("AbortError");
    io.send({ ...message, referenceImagePaths: ["success"] });
    expect((await io.next()).type).toBe("fixture_upload_started");
    expect(await io.next()).toEqual({ type: "result", id: message.id, value: { referenceCount: 1 } });
  });
});
