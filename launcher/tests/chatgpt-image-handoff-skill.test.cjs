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
  assert.match(routing, /optional `reference_image_paths`/);
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

test("handoff documents optional output controls without changing legacy calls", () => {
  assert.match(routing, /optional `output_options`/);
  assert.doesNotMatch(routing, /accepts only `prompt`, `output_path` and `turn_token`/);
  assert.match(skill, /"output_options": \{ "width": 32, "height": 32, "max_colors": 16, "binary_alpha": true \}/);
  assert.match(skill, /All controls are optional except that `width` and `height` must be supplied together/);
  assert.match(skill, /integers from 1 to 2048/);
  assert.match(skill, /integers from 2 to 256/);
  assert.match(skill, /distinct visible RGB colors/);
  assert.match(skill, /`output_options: \{\}` is invalid/);
  assert.match(skill, /Omitting `output_options` preserves legacy behavior/);
});

test("handoff distinguishes local output guarantees from model and visual fidelity", () => {
  assert.match(skill, /deterministic local post-processing after Web generation/);
  assert.match(skill, /contain.*aspect ratio.*transparent padding.*nearest-neighbor/);
  assert.match(skill, /palette reduction without dithering/);
  assert.match(skill, /below 128.*0.*128 or above.*255/);
  assert.match(skill, /does not mean the model generates native 32-pixel artwork/);
  assert.match(skill, /No fixed palette or shared color palette is supported/);
  assert.match(skill, /exact requested dimensions.*color limit.*binary alpha/);
  assert.match(skill, /pixel readability still requires visual QA/);
  assert.match(skill, /does not promise exact design fidelity/);
});

test("handoff preserves the original candidate and documents output metadata", () => {
  assert.match(skill, /original candidate.*`\*\.source\.png` sidecar/);
  for (const field of ["source_path", "source_width", "source_height", "output_options", "color_count", "binary_alpha"]) {
    assert.ok(skill.includes("`" + field + "`"), `Missing result field: ${field}`);
  }
});

test("reference handoff documents actual attachments, workspace limits and inspection", () => {
  assert.match(skill, /real file attachments/);
  assert.match(skill, /at most 5.*PNG, JPEG or WebP.*20 MiB each/);
  assert.match(skill, /absolute.*workspace paths/);
  assert.match(skill, /Inspect each actual reference image/);
  assert.match(skill, /does not guarantee.*identity/);
  assert.match(skill, /Never claim that a text path transmits pixels/);
  assert.match(skill, /"reference_image_paths": \["D:\/project\/references\/tree.png"\]/);
  assert.match(skill, /`referenceImagePaths`.*launcher API/);
  assert.match(skill, /-ReferenceImagePaths @\('D:\/project\/references\/tree.png'\)/);
  assert.doesNotMatch(routing, /it does not transport image attachments/);
});

const referenceCases = [
  { name: "omitted", parameters: {} },
  { name: "single", parameters: { ReferenceImagePaths: ["D:/workspace/ref [1].png"] } },
  { name: "multiple with output controls", parameters: {
    ReferenceImagePaths: ["D:/workspace/ref [1].png", "D:/workspace/ação ref.webp"],
    OutputOptions: { width: 32, height: 32, binary_alpha: true },
  } },
  { name: "explicit empty array", parameters: { ReferenceImagePaths: [] } },
];

for (const scenario of referenceCases) {
  test(`PowerShell forwards actual reference paths: ${scenario.name}`, {
    skip: process.platform !== "win32",
  }, () => {
    const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR = 'mock-descriptor'
$global:handoffDelivered = $false
function Test-Path { param($LiteralPath) ($LiteralPath -eq 'mock-descriptor') -or $global:handoffDelivered }
function Get-Content { '{"control":{"endpoint":"http://mock.invalid","token":"test-token"}}' }
function New-Item { }
function Get-Item { [pscustomobject]@{ FullName = 'D:/workspace/result.png'; Length = 12 } }
function Invoke-RestMethod {
  param($Method, $Uri, $Headers, $ContentType, $Body, $TimeoutSec)
  if ($Uri -ne 'http://mock.invalid/v1/image/generate') { throw 'Unexpected endpoint' }
  $global:handoffRequestBody = $Body
  $global:handoffDelivered = $true
  $request = $Body | ConvertFrom-Json
  [pscustomobject]@{ ok = $true; width = 32; height = 32; mimeType = 'image/png'; referenceCount = @($request.referenceImagePaths).Count }
}
$parameters = @{ Prompt = 'tree'; OutputPath = 'D:/workspace/result.png'; TraceId = 'test' }
$scenario = $env:HANDOFF_TEST_PARAMETERS | ConvertFrom-Json
foreach ($property in $scenario.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
if ($parameters.ContainsKey('OutputOptions')) {
  $options = @{}
  foreach ($property in $parameters.OutputOptions.PSObject.Properties) { $options[$property.Name] = $property.Value }
  $parameters.OutputOptions = $options
}
& $env:HANDOFF_TEST_SCRIPT @parameters | Out-Null
$global:handoffRequestBody
`;
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
    ], {
      encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { ...process.env,
        HANDOFF_TEST_PARAMETERS: JSON.stringify(scenario.parameters),
        HANDOFF_TEST_SCRIPT: path.join(__dirname, "..", "assets", "skills", "chatgpt-image-handoff", "scripts", "generate-image.ps1"),
      },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.prompt, "tree");
    assert.equal(payload.outputPath, "D:/workspace/result.png");
    assert.equal(payload.traceId, "test");
    assert.deepEqual(payload.referenceImagePaths, scenario.parameters.ReferenceImagePaths);
    assert.deepEqual(payload.outputOptions, scenario.parameters.OutputOptions);
    assert.equal(Object.hasOwn(payload, "reference_image_paths"), false);
  });
}
