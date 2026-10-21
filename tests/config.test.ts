import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, providerConfig } from "../src/config";

const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
const roots: string[] = [];
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function persist(config: Record<string, unknown>): void {
  const root = mkdtempSync(join(tmpdir(), "codex-subagent-config-"));
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
}

test("subagent saved chats default off including legacy configurations", () => {
  const config = defaultConfig("browser-only");
  expect(config.subagentUseSavedChats).toBe(false);
  const legacy: Record<string, unknown> = { ...config, useSavedChats: true };
  delete legacy.subagentUseSavedChats;
  persist(legacy);
  const loaded = loadConfig();
  expect(loaded.subagentUseSavedChats).toBe(false);
  expect(providerConfig(loaded).chatgptWeb).toMatchObject({ useSavedChats: true, subagentUseSavedChats: false });
});

test.each([true, false])("subagent saved chats %s survives loading and provider passthrough independently of root", (enabled) => {
  persist({ ...defaultConfig("browser-only"), subagentUseSavedChats: enabled, useSavedChats: !enabled });
  const loaded = loadConfig();
  expect(loaded.subagentUseSavedChats).toBe(enabled);
  for (const browserInteractionMode of ["automatic", "manual"] as const) {
    expect(providerConfig({ ...loaded, browserInteractionMode }).chatgptWeb)
      .toMatchObject({ subagentUseSavedChats: enabled, useSavedChats: !enabled });
  }
});

test.each(["true", "false", 0, 1, null, [], {}].map(invalid => ({ invalid })))("rejects nonboolean subagent saved chats: %j", ({ invalid }) => {
  persist({ ...defaultConfig("browser-only"), subagentUseSavedChats: invalid });
  expect(() => loadConfig()).toThrow("Invalid subagentUseSavedChats");
});
