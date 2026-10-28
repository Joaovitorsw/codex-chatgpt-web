param(
  [string]$OpenCodexRoot = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'OpenCodex')
)

$ErrorActionPreference = 'Stop'
function Test-OpenCodexReady {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3737/api/health' -TimeoutSec 3
  if ($health.gateway.projectRoot -ine $OpenCodexRoot -or $health.officialIpc.ready -ne $true) {
    throw 'OpenCodex runtime is not ready or belongs to another project.'
  }
}
$mutex = [Threading.Mutex]::new($false, 'Local\CodexWebGptOpenCodexStartup')
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { Write-Output 'OpenCodex startup is already in progress.'; return }

  $entry = Join-Path $OpenCodexRoot 'gateway\dev\run-gateway.cjs'
  if (-not (Test-Path -LiteralPath $entry)) { throw "OpenCodex gateway not found: $entry" }
  $url = 'http://127.0.0.1:3737'
  $listener = Get-NetTCPConnection -LocalPort 3737 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    if ($owner.CommandLine -notmatch [Regex]::Escape($OpenCodexRoot)) {
      throw 'Port 3737 belongs to another service; it was preserved.'
    }
    Test-OpenCodexReady
    Write-Output "OpenCodex is already running: $url"
    return
  }

  $logs = Join-Path (Split-Path -Parent $PSScriptRoot) 'work\opencodex'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stderr = Join-Path $logs "$stamp.stderr.log"
  $previousHost = $env:HOST
  $previousPort = $env:PORT
  try {
    $env:HOST = '127.0.0.1'
    $env:PORT = '3737'
    $process = Start-Process -FilePath (Get-Command node.exe -ErrorAction Stop).Source `
      -ArgumentList ('"' + $entry + '"') -WorkingDirectory $OpenCodexRoot `
      -WindowStyle Hidden -PassThru -RedirectStandardError $stderr `
      -RedirectStandardOutput (Join-Path $logs "$stamp.stdout.log")
  } finally {
    [Environment]::SetEnvironmentVariable('HOST', $previousHost, 'Process')
    [Environment]::SetEnvironmentVariable('PORT', $previousPort, 'Process')
  }
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    if ($process.HasExited) { throw "OpenCodex exited with code $($process.ExitCode). Log: $stderr" }
    try {
      Test-OpenCodexReady
      Write-Output "OpenCodex started silently: $url (runner PID $($process.Id))."
      return
    } catch { Start-Sleep -Milliseconds 500 }
  }
  throw "OpenCodex is still starting or unavailable. Log: $stderr"
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
