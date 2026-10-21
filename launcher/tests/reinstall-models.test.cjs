const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");

function setupFixture({ installed = true, fails = false, development = false } = {}) {
  const calls = [];
  const handlers = new Map();
  const state = { coreSetupComplete: installed, browserInteractionMode: "automatic" };
  const context = vm.createContext({
    handle: (name, handler) => handlers.set(name, handler),
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    IS_DEV_PROFILE: development, BUNDLED_SKILLS_PATH: "/fixture/skills", LAUNCHER_PROFILE: { codexHome: "/fixture/codex" },
    smokePassedThisSession: false, smokePassedForCurrentVersion: () => false,
    listBundledSkills: () => [], validateBundledSkillSelection: value => value,
    syncBundledSkills: () => { calls.push("skills"); return {}; },
    codexDesktop: { withRestart: async operation => {
      calls.push("close-codex");
      try { return await operation(); } finally { calls.push("open-codex"); }
    } },
    runtimeSupervisor: { cancelActiveTurns: async () => { calls.push("cancel-turns"); } },
    browserHost: { probeAuthentication: async () => { calls.push("auth"); return { authenticated: true }; },
      returnToIdle: async () => { calls.push("idle"); } },
    runtimeHost: {
      currentOperation: () => null,
      setupCore: async () => { calls.push("setup"); if (fails) throw new Error("setup failed"); return { mode: "full", stdout: "ok" }; },
      setupDevCore: async () => { calls.push("dev-setup"); return { mode: "full" }; },
      runtimeConfigSnapshot: () => ({ config: {} }),
    },
    startCatalogVerificationMonitor: () => calls.push("verify"),
    logger: { warn() {} }, send() {},
  });
  const start = main.indexOf('  handle("launcher:setup-core",');
  const end = main.indexOf('  handle("launcher:setup-mcp",', start);
  vm.runInContext(main.slice(start, end), context);
  return { calls, run: () => handlers.get("launcher:setup-core")({}, {}), state };
}

test("reinstall closes Codex and cancels its turns before setup, then reopens it", async () => {
  const fixture = setupFixture();
  await fixture.run();
  assert.deepEqual(fixture.calls, ["close-codex", "cancel-turns", "setup", "skills", "idle", "open-codex", "verify"]);
});

test("failed reinstall still reopens Codex and preserves the error", async () => {
  const fixture = setupFixture({ fails: true });
  await assert.rejects(fixture.run(), /setup failed/);
  assert.deepEqual(fixture.calls, ["close-codex", "cancel-turns", "setup", "open-codex"]);
});

test("development profile setup leaves production Codex instances alone", async () => {
  const fixture = setupFixture({ development: true });
  await fixture.run();
  assert.deepEqual(fixture.calls, ["dev-setup", "skills", "idle"]);
});

test("reinstall stays enabled while an ordinary browser turn is running", () => {
  const row = renderer.slice(renderer.indexOf("action={snapshot.state.coreSetupComplete"));
  assert.match(row.slice(0, row.indexOf("</div>")), /disabled=\{installBusy\}/);
  assert.match(renderer, /const installBusy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(renderer, /if \(!snapshot\.state\.coreSetupComplete && !manualInteraction && !browserSetupGateComplete\)/);
});
