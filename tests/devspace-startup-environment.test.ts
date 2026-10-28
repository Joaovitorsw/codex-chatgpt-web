import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "win32").each(["pwsh", "powershell"])("DevSpace integration isolates the OpenCodex PORT and restores it in %s", shell => {
  const root = mkdtempSync(join(tmpdir(), "devspace-port-"));
  const source = resolve("scripts/start-local-production-silent.ps1").replaceAll("'", "''");
  copyFileSync("scripts/devspace-settings.ps1", join(root, "devspace-settings.ps1"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 7676 }));
  writeFileSync(join(root, "ensure-devspace-tunnel.ps1"), "Write-Output ('tunnel-port=' + $env:PORT)");
  const probe = join(root, "probe.ps1");
  writeFileSync(probe, `\ufeff
$ErrorActionPreference = 'Stop'
$devSpaceLogDir = $PSScriptRoot
$DevSpaceOnly = $true
$IntegrationWorker = $false
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-DevSpaceIntegration' }, $true)
Invoke-Expression $definition.Extent.Text.Replace('$PSScriptRoot', "'" + $PSScriptRoot.Replace("'", "''") + "'")
function Start-DevSpaceIfNeeded { Write-Output ('native-port=' + $env:PORT) }
. (Join-Path $PSScriptRoot 'devspace-settings.ps1')
Write-Output ('standalone-port=' + (Get-DevSpaceSettings).Port)
Start-DevSpaceIntegration
Write-Output ('caller-port=' + $env:PORT)
`);
  try {
    const result = Bun.spawnSync([shell, "-NoProfile", "-File", probe], {
      env: { ...process.env, PORT: "3737", DEVSPACE_CONFIG_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("native-port=7676");
    expect(output).toContain("standalone-port=3737");
    expect(output).toContain("tunnel-port=7676");
    expect(output).toContain("caller-port=3737");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
