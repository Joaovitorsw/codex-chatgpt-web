const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const skill = fs.readFileSync(path.join(
  __dirname, "..", "assets", "skills", "chatgpt-image-handoff", "SKILL.md",
), "utf8");
const description = skill.split(/\r?\n/).find(line => line.startsWith("description:"));
const routing = skill.split("## Routing")[1]?.split("## ")[0] ?? "";

test("image handoff discovery is limited to the executing Web model", () => {
  assert.match(description, /executing model is a Codex Web GPT model/);
  assert.match(routing, /Only prefer this handoff when the executing model is a Codex Web GPT model/);
  assert.match(routing, /launcher descriptor or installed skill alone does not establish/);
});

test("native and unknown model contexts retain the default imagegen workflow", () => {
  assert.match(routing, /For native models or when the executing model cannot be verified, preserve the default `imagegen` workflow/);
  assert.match(routing, /Do not switch a native task to the Web handoff/);
});

test("Web routing checks actual capabilities and permits suitable reference tools", () => {
  assert.match(routing, /Discover the tools actually exposed/);
  assert.match(routing, /does not transport image attachments/);
  assert.match(routing, /reference-capable image tool under the `imagegen` skill/);
  assert.match(routing, /Do not silently substitute text reconstruction for exact fidelity/);
  assert.match(routing, /reloading the session is not a mandatory precondition/);
  assert.doesNotMatch(skill, /must be reloaded before trying a fallback|unavailable before running the bundled script/);
});

test("handoff retains active-turn, non-destructive delivery and parent-task safeguards", () => {
  assert.match(routing, /authoritative active-turn tokens/);
  assert.match(routing, /Do not invoke the bundled out-of-band PowerShell script during an active Web turn/);
  assert.match(skill, /Save the candidate non-destructively/);
  assert.match(skill, /Never replace, reset, or close the parent conversation/);
  assert.match(skill, /`generated=true` and a readable local file/);
  assert.match(skill, /Resume the parent task after every cycle/);
});

test("production assets retain reference, grid, alpha, motion and integration acceptance", () => {
  assert.match(skill, /## Game asset production/);
  assert.match(skill, /Freeze the production contract before generation/);
  assert.match(skill, /native pixel size, grid\/spacing, real alpha/);
  assert.match(skill, /Repeated identical frames are holds, not new animation/);
  assert.match(skill, /Validate actual motion and compatible tile joins separately/);
  assert.match(skill, /requested pack manifest references it and that reference has been checked/);
});

test("bundles the documented read-only validator with working help", () => {
  const validator = path.join(
    __dirname, "..", "assets", "skills", "chatgpt-image-handoff", "scripts", "validate-pixel-asset.py",
  );
  assert.equal(fs.existsSync(validator), true, "The documented validator must ship with the skill");
  const result = spawnSync("python", ["-S", "-B", validator, "--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, /--image ABS_PNG/);
  assert.match(result.stdout, /--manifest ABS_JSON/);
  assert.match(result.stdout, /No file writes/);
});

test("Web probe 429 guidance distinguishes transport from generation and bounds recovery", () => {
  assert.match(routing, /MCP\/tunnel SSE probe returns 429/);
  assert.match(routing, /transport failure before the generator/);
  assert.match(routing, /Do not infer image-generation quota exhaustion or an API key requirement/);
  assert.match(routing, /Retry once only after a meaningful state change/);
  assert.match(routing, /Preserve the parent conversation and report the transport blocker/);
});
