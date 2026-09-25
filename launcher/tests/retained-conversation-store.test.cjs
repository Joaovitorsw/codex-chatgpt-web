const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRetainedConversationStore } = require("../electron/retained-conversation-store.cjs");

test("retained conversations survive a launcher restart and remain connector-bound", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-retained-chat-"));
  const file = path.join(root, "retained.json");
  const key = "a".repeat(64);
  try {
    const first = createRetainedConversationStore(file);
    assert.equal(first.set(key, {
      url: "https://chatgpt.com/c/conversation-123?utm_private=value#answer",
      connectorIdentity: "Codex Native2",
    }), true);
    const restored = createRetainedConversationStore(file);
    assert.deepEqual(restored.get(key, "Codex Native2"), {
      url: "https://chatgpt.com/c/conversation-123",
      connectorIdentity: "Codex Native2",
      updatedAt: restored.get(key, "Codex Native2").updatedAt,
    });
    assert.equal(restored.get(key, "Other Connector"), undefined);
    assert.equal(restored.delete(key), true);
    assert.equal(createRetainedConversationStore(file).get(key, "Codex Native2"), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained conversations reject non-chat URLs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-retained-chat-invalid-"));
  try {
    const store = createRetainedConversationStore(path.join(root, "retained.json"));
    assert.equal(store.set("b".repeat(64), {
      url: "https://example.com/c/not-chatgpt",
      connectorIdentity: "Codex Native2",
    }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
