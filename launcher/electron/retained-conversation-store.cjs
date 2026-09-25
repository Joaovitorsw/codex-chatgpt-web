const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const MAX_RETAINED_CONVERSATIONS = 32;

function normalizedChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || !/^\/c\/[^/]+$/.test(url.pathname)) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function readEntries(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1 || !parsed.conversations || typeof parsed.conversations !== "object") {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed.conversations).flatMap(([key, entry]) => {
      const url = normalizedChatUrl(entry?.url);
      if (!/^[a-f0-9]{64}$/.test(key) || !url
        || typeof entry?.connectorIdentity !== "string"
        || !entry.connectorIdentity.trim()
        || !Number.isFinite(Date.parse(entry?.updatedAt))) return [];
      return [[key, { url, connectorIdentity: entry.connectorIdentity, updatedAt: entry.updatedAt }]];
    }));
  } catch {
    return {};
  }
}

function createRetainedConversationStore(filePath) {
  let conversations = readEntries(filePath);
  const persist = () => writePrivateFileAtomic(filePath, `${JSON.stringify({
    version: 1,
    conversations,
  }, null, 2)}\n`);
  return {
    get(key, connectorIdentity) {
      const entry = conversations[key];
      return entry?.connectorIdentity === connectorIdentity ? { ...entry } : undefined;
    },
    set(key, value) {
      const url = normalizedChatUrl(value?.url);
      if (!/^[a-f0-9]{64}$/.test(key) || !url
        || typeof value?.connectorIdentity !== "string" || !value.connectorIdentity.trim()) return false;
      conversations[key] = {
        url,
        connectorIdentity: value.connectorIdentity,
        updatedAt: new Date().toISOString(),
      };
      const newest = Object.entries(conversations)
        .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
        .slice(0, MAX_RETAINED_CONVERSATIONS);
      conversations = Object.fromEntries(newest);
      persist();
      return true;
    },
    delete(key) {
      if (!Object.hasOwn(conversations, key)) return false;
      delete conversations[key];
      persist();
      return true;
    },
  };
}

module.exports = { createRetainedConversationStore, normalizedChatUrl };
