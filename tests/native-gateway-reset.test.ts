import { expect, test } from "bun:test";
import { resolve } from "node:path";

test.skipIf(process.platform !== "win32").each(["pwsh", "powershell"])("worker reset preserves independent gateways in %s", shell => {
  const source = resolve("scripts/restart-local-production-safe.ps1").replaceAll("'", "''");
  const probe = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid reset script' }
$assignment = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$companionRoots' }, $true)
$openCodexEntry = 'C:\\fixture\\open.cjs'
$nativeGatewayEntry = 'C:\\fixture\\native.mjs'
function Get-CimInstance {
  [pscustomobject]@{ Name='node.exe'; CommandLine=$openCodexEntry }
  [pscustomobject]@{ Name='node.exe'; CommandLine=$nativeGatewayEntry }
  [pscustomobject]@{ Name='node.exe'; CommandLine='unrelated.mjs' }
}
$PreserveOpenCodex = $true
Invoke-Expression $assignment.Extent.Text
if ($companionRoots.Count -ne 0) { throw 'Worker reset would stop an independent gateway' }
$PreserveOpenCodex = $false
Invoke-Expression $assignment.Extent.Text
if ($companionRoots.Count -ne 2) { throw 'Full restart must select both owned gateways' }
Write-Output 'RESET_SELECTION_OK'
`;
  const result = Bun.spawnSync([shell, "-NoProfile", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("RESET_SELECTION_OK");
});
