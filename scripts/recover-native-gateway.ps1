$ErrorActionPreference = 'Stop'
$guard = [Threading.Mutex]::new($false, 'Local\CodexWebGptNativeGatewayRecovery')
$locked = $false
try {
  try { $locked = $guard.WaitOne(60000) }
  catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Gateway recovery is already in progress.' }
  # Isolate the startup script's exit statement from this health verification.
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-local-production-silent.ps1') -DevSpaceOnly *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Gateway startup failed.' }
  . (Join-Path $PSScriptRoot 'devspace-settings.ps1')
  $settings = Get-DevSpaceSettings -IgnoreInheritedPort
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($settings.Port)/healthz" -TimeoutSec 3
  if ($health.ok -ne $true -or $health.name -ne 'devspace' -or $health.mode -ne 'native') {
    throw 'Native gateway health could not be verified.'
  }
} catch {
  # Avoid exposing startup output, configuration or credentials through the adapter.
  Write-Error 'Native gateway recovery failed.'
  exit 1
} finally {
  if ($locked) { $guard.ReleaseMutex() }
  $guard.Dispose()
}
