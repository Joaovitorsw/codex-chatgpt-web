const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { listBundledSkills } = require("../electron/bundled-skills.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const skillsRoot = path.join(launcherRoot, "assets", "skills");
const skillRoot = path.join(skillsRoot, "codex-native-task-bridge");
const scriptPath = path.join(skillRoot, "scripts", "manage-native-codex-task.ps1");

function runPowerShell(args, expectedStatus = 0) {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return lines.length > 0 ? JSON.parse(lines.at(-1)) : null;
}

test("bundles an implicitly discoverable native Codex task bridge", () => {
  assert.ok(listBundledSkills(skillsRoot).includes("codex-native-task-bridge"));
  assert.equal(fs.existsSync(path.join(skillRoot, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(skillRoot, "agents", "openai.yaml")), true);
  assert.equal(fs.existsSync(path.join(skillRoot, ".managed-by-codex-web-gpt")), true);
  assert.equal(fs.existsSync(scriptPath), true);
});

test("creates a visible app-server task and resumes it without loading the Web GPT route", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-task-bridge-"));
  const codexHome = path.join(root, "codex");
  const stateRoot = path.join(root, "bridge");
  const fakeCodex = path.join(root, "fake-codex.js");
  const threadId = "01a0dbf1-8e9a-7502-861d-53a02b02bf9c";
  fs.writeFileSync(fakeCodex, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const readline = require("node:readline");',
    'const args = process.argv.slice(2);',
    `const threadId = "${threadId}";`,
    'if (args.includes("app-server")) {',
    '  const rl = readline.createInterface({ input: process.stdin });',
    '  const send = value => process.stdout.write(JSON.stringify(value) + "\\n");',
    '  rl.on("line", line => {',
    '    const request = JSON.parse(line);',
    '    if (request.method === "initialize") send({ id: request.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "windows", platformOs: "windows" } });',
    '    if (request.method === "model/list") send({ id: request.id, result: { data: [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", description: "native", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null } });',
    '    if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: threadId, source: "vscode", originator: "Codex Desktop", path: path.join(process.env.CODEX_HOME, "sessions", `rollout-${threadId}.jsonl`) }, model: "gpt-6-astra", modelProvider: "openai" } });',
    '    if (request.method === "turn/start") {',
    '      send({ id: request.id, result: { turn: { id: "turn_test", status: "inProgress", items: [] } } });',
    '      send({ method: "turn/completed", params: { threadId, turn: { id: "turn_test", status: "completed", items: [] } } });',
    '    }',
    '    if (request.method === "thread/read") send({ id: request.id, result: { thread: { id: threadId, source: "vscode", originator: "Codex Desktop", path: path.join(process.env.CODEX_HOME, "sessions", `rollout-${threadId}.jsonl`), turns: [{ id: "turn_test", status: "completed", items: [{ type: "agentMessage", text: "NATIVE_TASK_OK" }] }] } } });',
    '  });',
    '  return;',
    '}',
    'const outputIndex = args.indexOf("-o");',
    'if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], "NATIVE_TASK_OK\\n");',
    'const sessionDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "09", "26");',
    'fs.mkdirSync(sessionDir, { recursive: true });',
    'const rollout = path.join(sessionDir, `rollout-2026-09-26T00-00-00-${threadId}.jsonl`);',
    'fs.writeFileSync(rollout, [',
    '  JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: process.cwd(), source: "vscode", model_provider: "openai" } }),',
    '  JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),',
    '  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "Crie um teste nativo" }] } }),',
    '  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "NATIVE_TASK_OK" }] } }),',
    '  JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "NATIVE_TASK_OK" } }),',
    '].join("\\n") + "\\n");',
    `process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "${threadId}" }) + "\\n");`,
    'process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "NATIVE_TASK_OK" } }) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
    "",
  ].join("\n"));
  try {
    const createDryRun = runPowerShell([
      "-Action", "Create",
      "-Prompt", "Crie um teste nativo",
      "-WorkingDirectory", launcherRoot,
      "-CodexPath", process.execPath,
      "-CodexPrefixArguments", fakeCodex,
      "-CodexHome", codexHome,
      "-StateRoot", stateRoot,
      "-DryRun",
    ]);
    assert.equal(createDryRun.nativeCodex, true);
    assert.equal(createDryRun.visibleInCodex, true);
    assert.equal(createDryRun.transport, "app-server");
    assert.deepEqual(createDryRun.arguments.slice(0, 5), [
      fakeCodex, "app-server", "--stdio", "-c", 'openai_base_url=""',
    ]);
    assert.equal(createDryRun.arguments.some(value => String(value).startsWith("chatgpt-web/")), false);

    const created = runPowerShell([
      "-Action", "Create",
      "-Prompt", "Crie um teste nativo",
      "-WorkingDirectory", launcherRoot,
      "-CodexPath", process.execPath,
      "-CodexPrefixArguments", fakeCodex,
      "-CodexHome", codexHome,
      "-StateRoot", stateRoot,
    ]);
    assert.equal(created.status, "completed");
    assert.equal(created.nativeCodex, true);
    assert.equal(created.visibleInCodex, true);
    assert.equal(created.transport, "app-server");
    assert.equal(created.source, "vscode");
    assert.equal(created.model, "gpt-6-astra");
    assert.equal(created.modelProvider, "openai");
    assert.equal(created.threadId, threadId);
    assert.equal(created.finalMessage, "NATIVE_TASK_OK");
    assert.equal(fs.existsSync(created.eventLog), true);
    assert.equal(fs.existsSync(created.receiptPath), true);

    const resumeDryRun = runPowerShell([
      "-Action", "Resume",
      "-ThreadId", threadId,
      "-Prompt", "Continue o teste",
      "-WorkingDirectory", launcherRoot,
      "-CodexPath", process.execPath,
      "-CodexPrefixArguments", fakeCodex,
      "-CodexHome", codexHome,
      "-StateRoot", stateRoot,
      "-DryRun",
    ]);
    assert.deepEqual(resumeDryRun.arguments.slice(0, 5), [
      fakeCodex, "exec", "resume", "--ignore-user-config", "--json",
    ]);
    assert.ok(resumeDryRun.arguments.includes(threadId));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a ChatGPT conversation url as a native Codex task id", {
  skip: process.platform !== "win32",
}, () => {
  const result = spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-File", scriptPath,
    "-Action", "Resume",
    "-ThreadId", "https://chatgpt.com/c/6ab6c63e-d830-83e9-aa1b-72d4dfe4c7b8",
    "-Prompt", "Teste",
    "-WorkingDirectory", launcherRoot,
    "-DryRun",
  ], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a ChatGPT conversation id or URL/);
});
