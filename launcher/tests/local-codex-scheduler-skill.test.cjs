const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { listBundledSkills } = require("../electron/bundled-skills.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const skillsRoot = path.join(launcherRoot, "assets", "skills");
const skillRoot = path.join(skillsRoot, "codex-local-scheduler");
const scriptPath = path.join(skillRoot, "scripts", "manage-codex-schedule.ps1");

function runPowerShell(args) {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

test("bundles the local scheduler as a selectable managed skill", () => {
  assert.ok(listBundledSkills(skillsRoot).includes("codex-local-scheduler"));
  assert.equal(fs.existsSync(path.join(skillRoot, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(skillRoot, "agents", "openai.yaml")), true);
  assert.equal(fs.existsSync(path.join(skillRoot, ".managed-by-codex-web-gpt")), true);
  assert.equal(fs.existsSync(scriptPath), true);
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(script, /System\.Diagnostics\.ProcessStartInfo/);
  assert.match(script, /RedirectStandardError = \$true/);
});

test("builds and executes a safe resume invocation without registering a Windows task", {
  skip: process.platform !== "win32",
}, () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-scheduler-skill-"));
  const codexHome = path.join(stateRoot, "codex");
  const threadId = "01a0dbf1-8e9a-7502-861d-53a02b02bf9c";
  const message = "Primeira linha\n\"segunda linha\"";
  const fakeCodex = path.join(stateRoot, "fake-codex.js");
  fs.writeFileSync(fakeCodex, [
    `process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "${threadId}" }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
    "",
  ].join("\n"));
  const sessionDir = path.join(codexHome, "sessions", "2026", "09", "26");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `rollout-${threadId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "vscode", model_provider: "openai" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol", effort: "low" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "READY" } }),
    "",
  ].join("\n"));
  try {
    const created = runPowerShell([
      "-Action", "Create",
      "-Name", "teste-agendador",
      "-ThreadId", threadId,
      "-Message", message,
      "-NativeCodex",
      "-DelaySeconds", "10",
      "-WorkingDirectory", launcherRoot,
      "-CodexHome", codexHome,
      "-StateRoot", stateRoot,
      "-CodexPath", process.execPath,
      "-CodexPrefixArguments", fakeCodex,
      "-RetryCount", "1",
      "-RetryDelaySeconds", "1",
      "-DryRun",
    ]);
    assert.equal(created.name, "teste-agendador");
    assert.equal(created.threadId, threadId);
    assert.equal(created.threadUrl, `codex://threads/${threadId}`);
    assert.equal(created.registered, false);

    const definition = JSON.parse(fs.readFileSync(created.definitionPath, "utf8"));
    assert.equal(definition.message, message);
    assert.equal(definition.mode, "Resume");
    assert.equal(definition.nativeCodex, true);
    assert.equal(definition.threadUrl, `codex://threads/${threadId}`);
    assert.equal(definition.sandbox, "read-only");
    assert.equal(definition.codexPath, process.execPath);
    assert.deepEqual(definition.codexPrefixArguments, [fakeCodex]);
    assert.equal(definition.model, "gpt-6-sol");
    assert.equal(definition.reasoningEffort, "low");
    const scheduledDelay = new Date(definition.scheduledAt).getTime() - Date.now();
    assert.ok(scheduledDelay > 5000 && scheduledDelay <= 12000, `unexpected delay: ${scheduledDelay}`);

    const second = runPowerShell([
      "-Action", "Create",
      "-Name", "teste-agendador-2",
      "-ThreadId", threadId,
      "-Message", "Segundo teste no mesmo chat",
      "-NativeCodex",
      "-DelaySeconds", "20",
      "-WorkingDirectory", launcherRoot,
      "-CodexHome", codexHome,
      "-StateRoot", stateRoot,
      "-CodexPath", process.execPath,
      "-CodexPrefixArguments", fakeCodex,
      "-DryRun",
    ]);
    assert.equal(second.threadId, created.threadId);
    assert.equal(second.threadUrl, created.threadUrl);

    const invocation = runPowerShell([
      "-Action", "RunNow",
      "-Name", "teste-agendador",
      "-StateRoot", stateRoot,
      "-DryRun",
    ]);
    assert.equal(invocation.dryRun, true);
    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.arguments[0], fakeCodex);
    assert.equal(invocation.threadId, threadId);
    assert.equal(invocation.threadUrl, `codex://threads/${threadId}`);
    assert.deepEqual(invocation.arguments.slice(1, 6), [
      "exec", "resume", "--ignore-user-config", "--json", "-m",
    ]);
    assert.ok(invocation.arguments.includes(threadId));
    assert.ok(invocation.arguments.includes(message));
    assert.ok(invocation.arguments.includes('model_reasoning_effort="low"'));

    const executed = runPowerShell([
      "-Action", "RunNow",
      "-Name", "teste-agendador",
      "-StateRoot", stateRoot,
    ]);
    assert.equal(executed.status, "completed");
    assert.equal(executed.lastTaskResult, 0);
    const logEntries = fs.readFileSync(definition.logPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(logEntries.map(entry => entry.status), ["started", "completed"]);
    assert.equal(logEntries[1].attempt, 1);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
