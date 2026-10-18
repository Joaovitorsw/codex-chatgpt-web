const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("image generation publishes its exact auxiliary target before the reference helper reads the descriptor", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-reference-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptorPath = path.join(root, "browser.json");
  fs.writeFileSync(descriptorPath, JSON.stringify({ surfaceTargets: { home: "parent-target" } }));
  const reference = path.join(root, "reference.png");
  fs.writeFileSync(reference, Buffer.from("89504e470d0a1a0a00000000", "hex"));
  let url = "about:blank";
  let helperCalled = false;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => url,
    loadURL: async value => { url = value; },
    getOrCreateDevToolsTargetId: () => "image-target",
    insertText() {},
    executeJavaScript: async script => {
      if (script.includes("temporaryFromUrl")) return { ready: true };
      if (script.includes(".map(image => image.currentSrc")) return [];
      return true;
    },
  });
  const tab = { id: "image-tab", surfaceId: "image-surface", view: { webContents: contents } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    descriptorPath, selectedTabId: "home", turnTabs: new Map(),
    ready: async () => {},
    createTurnTab: async () => { host.turnTabs.set(tab.id, tab); return tab; },
    snapshot: () => ({}), connectorName: () => "Codex Native2",
    syncViewVisibility() {}, removeTurnTab: () => host.turnTabs.delete(tab.id),
    writeDescriptor: () => fs.writeFileSync(descriptorPath, JSON.stringify({
      surfaceTargets: Object.fromEntries([...host.turnTabs.values()].map(value => [value.surfaceId, value.view.webContents.getOrCreateDevToolsTargetId()])),
    })),
    runBrowserHelperOperation: async request => {
      helperCalled = true;
      const descriptor = JSON.parse(fs.readFileSync(request.descriptorPath, "utf8"));
      assert.equal(descriptor.surfaceTargets[tab.surfaceId], request.payload.targetId);
      assert.deepEqual(request.payload.referenceImagePaths, [fs.realpathSync(reference)]);
      throw new Error("verified reference upload boundary");
    },
  });
  await assert.rejects(host.generateImageAsset({
    traceId: "reference_lifecycle", prompt: "same character", outputPath: path.join(root, "next.png"), referenceImagePaths: [reference],
  }), /verified reference upload boundary/);
  assert.equal(helperCalled, true);
  assert.equal(host.turnTabs.size, 0);
  assert.equal(fs.existsSync(path.join(root, "next.png")), false);
});
