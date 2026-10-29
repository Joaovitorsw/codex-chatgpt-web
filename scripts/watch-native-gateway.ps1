param([switch]$Once)

$ErrorActionPreference = 'Stop'
$guard = [Threading.Mutex]::new($false, 'Local\CodexWebGptNativeGatewayWatchdog')
$locked = $false
try {
  try { $locked = $guard.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { return }
  . (Join-Path $PSScriptRoot 'devspace-settings.ps1')
  $logPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'work\devspace\watchdog.log'
  do {
    try {
      $settings = Get-DevSpaceSettings -IgnoreInheritedPort
      $listener = Get-NetTCPConnection -LocalPort $settings.Port -State Listen -ErrorAction SilentlyContinue
      if (-not $listener) {
        Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) Gateway listener absent; starting recovery."
        & (Join-Path $PSScriptRoot 'start-local-production-silent.ps1') -DevSpaceOnly
      }
    } catch {
      Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) Recovery failed: $($_.Exception.Message)"
    }
    if (-not $Once) { Start-Sleep -Seconds 30 }
  } while (-not $Once)
} finally {
  if ($locked) { $guard.ReleaseMutex() }
  $guard.Dispose()
}
