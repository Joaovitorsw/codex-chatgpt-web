param(
  [switch]$Wait
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repoRoot 'run-local-production.cmd'
$logDir = Join-Path $repoRoot 'work\local-production'
$launcherEntry = Join-Path $repoRoot 'launcher'

if (-not (Test-Path -LiteralPath $runner)) {
  throw "Local production runner was not found: $runner"
}

# A second development launcher cannot bind Vite's fixed port and may still open
# another Electron process before it notices the conflict. Detect the exact local
# launcher path first so repeated double-clicks remain safe and silent.
$escapedLauncherEntry = [Regex]::Escape($launcherEntry)
$existingLauncher = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -ieq 'electron.exe' -and
    $_.CommandLine -match $escapedLauncherEntry -and
    $_.CommandLine -notmatch '--type='
  } |
  Select-Object -First 1

if ($null -ne $existingLauncher) {
  Write-Output "Local production launcher is already running (PID $($existingLauncher.ProcessId))."
  exit 0
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logDir "launcher-$stamp.stdout.log"
$stderr = Join-Path $logDir "launcher-$stamp.stderr.log"

# The cmd runner is retained for manual troubleshooting. This wrapper is the normal
# background mode: it inherits a per-process silent flag, writes diagnostics to files,
# and never leaves a console window or a hidden `pause` process behind.
$priorSilent = $env:CODEX_WEB_GPT_SILENT
$priorStartHidden = $env:CODEX_WEB_GPT_START_HIDDEN
try {
  $env:CODEX_WEB_GPT_SILENT = '1'
  $env:CODEX_WEB_GPT_START_HIDDEN = '1'
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $runner) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr -PassThru
} finally {
  if ($null -eq $priorSilent) { Remove-Item Env:CODEX_WEB_GPT_SILENT -ErrorAction SilentlyContinue }
  else { $env:CODEX_WEB_GPT_SILENT = $priorSilent }
  if ($null -eq $priorStartHidden) { Remove-Item Env:CODEX_WEB_GPT_START_HIDDEN -ErrorAction SilentlyContinue }
  else { $env:CODEX_WEB_GPT_START_HIDDEN = $priorStartHidden }
}

Write-Output "Local production launcher started silently (PID $($process.Id))."
Write-Output "Logs: $stdout"

if ($Wait) {
  $process.WaitForExit()
  exit $process.ExitCode
}
