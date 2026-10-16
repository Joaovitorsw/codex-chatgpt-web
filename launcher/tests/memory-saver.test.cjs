const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserHost } = require('../electron/browser-host.cjs');
const { createStateStore } = require('../electron/state.cjs');

test('memory saver persists across launcher restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memory-saver-'));
  try {
    const file = path.join(root, 'state.json');
    const store = createStateStore(file);
    assert.equal(store.read().memorySaver, false);
    store.update({ memorySaver: true });
    assert.equal(createStateStore(file).read().memorySaver, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fixture(saved = true, enabled = true) {
  const now = Date.now();
  const tabs = [
    { id: 'saved', status: 'ready', conversationKey: 'durable-key' },
    { id: 'active', status: 'running', bootstrapReady: true, helperPid: process.pid, lastHeartbeatAt: now },
    { id: 'manual', status: 'ready', interactionMode: 'manual' },
    { id: 'finalizing', status: 'ready', finalizingUntil: now + 1000 },
    { id: 'failed', status: 'error', failedAt: now - 35_000 },
  ].map(tab => ({ interactionMode: 'automatic', lastHeartbeatAt: now - 35_000, ...tab }));
  const host = Object.create(BrowserHost.prototype);
  const removed = [];
  Object.assign(host, {
    getMemorySaver: () => enabled,
    getUseSavedChats: () => saved,
    lastTurnSweepAt: now,
    turnTabs: new Map(tabs.map(tab => [tab.id, tab])),
    logger: { info() {}, warn() {} },
    removeTurnTab(tab, abort) { assert.equal(abort, false); removed.push(tab.id); this.turnTabs.delete(tab.id); },
  });
  return { host, removed, now };
}

test('memory saver releases completed saved documents while preserving active, manual and finalizing turns', async () => {
  const { host, removed, now } = fixture();
  await host.reapExpiredTurnTabs(now);
  assert.deepEqual(removed.sort(), ['failed', 'saved']);
  assert.deepEqual([...host.turnTabs.keys()].sort(), ['active', 'finalizing', 'manual']);
});

test('temporary conversation context survives memory saving and normal mode keeps its existing retention', async () => {
  const temporary = fixture(false);
  await temporary.host.reapExpiredTurnTabs(temporary.now);
  assert.equal(temporary.host.turnTabs.has('saved'), true);
  const normal = fixture(true, false);
  await normal.host.reapExpiredTurnTabs(normal.now);
  assert.deepEqual(normal.removed, []);
});

test('enabling memory saver releases the preloaded document and prevents its recreation', async () => {
  const { host } = fixture();
  let closed = 0;
  host.prewarmedTurnTab = { id: 'prewarm', view: { webContents: { isDestroyed: () => false, close: () => { closed++; } } } };
  host.window = { contentView: { removeChildView() {} } };
  host.writeDescriptor = () => {};
  host.applyMemorySaver();
  assert.equal(closed, 1);
  assert.equal(host.prewarmedTurnTab, null);
  host.createTurnTab = () => { throw new Error('must not preload in memory saver'); };
  await host.ensurePrewarmedTurnTab();
});
