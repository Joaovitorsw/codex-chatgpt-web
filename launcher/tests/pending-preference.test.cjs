const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
const helpers = main.slice(
  main.indexOf("function syncFreshConversationPreference("),
  main.indexOf("function registerIpc("),
);

test("queued fresh-conversation preference waits for idleness and then applies", async () => {
  const state = {
    experimentalFreshConversationPerTurn: false,
    pendingFreshConversationPerTurn: null,
    useSavedChats: false,
  };
  const config = {
    experimentalFreshConversationPerTurn: false,
    useSavedChats: false,
  };
  const events = [];
  let activeTraceId = "active-turn";
  let calls = 0;
  const sandbox = {
    app: {},
    applyingPendingFreshConversation: false,
    browserHost: {
      get activeTraceId() { return activeTraceId; },
      currentOperation: () => null,
      turnTabs: new Map(),
    },
    runtimeHost: {
      currentOperation: () => null,
      runtimeConfigSnapshot: () => ({ config }),
      setFreshConversationPerTurn: async enabled => {
        calls += 1;
        config.experimentalFreshConversationPerTurn = enabled;
      },
    },
    stateStore: {
      read: () => ({ ...state }),
      update: patch => Object.assign(state, patch),
    },
    logger: { info: () => {}, debug: () => {} },
    send: (channel, value) => events.push([channel, { ...value }]),
    publishOperation: operation => events.push(["operation", operation]),
    releaseRetainedConversation: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${helpers}\nthis.queue = queueFreshConversationPreference; this.apply = applyPendingFreshConversationPreference;`, sandbox);

  sandbox.queue(sandbox.stateStore, true);
  assert.equal(state.pendingFreshConversationPerTurn, true);
  await sandbox.apply({ logger: sandbox.logger, stateStore: sandbox.stateStore });
  assert.equal(calls, 0, "an active turn keeps the preference queued");

  activeTraceId = null;
  await sandbox.apply({ logger: sandbox.logger, stateStore: sandbox.stateStore });
  assert.equal(calls, 1);
  assert.equal(state.experimentalFreshConversationPerTurn, true);
  assert.equal(state.pendingFreshConversationPerTurn, null);
  assert.equal(events.at(-1)[0], "launcher:state-changed");
});
