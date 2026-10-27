param(
  [switch]$Wait,
  [switch]$DevSpaceOnly,
  [switch]$IntegrationWorker,
  [ValidateSet('minimal', 'full', 'codex', 'native')]
  [string]$DevSpaceToolMode = 'native'
)

$ErrorActionPreference = 'Stop'
if (-not $IntegrationWorker) {
$startupMutex = [Threading.Mutex]::new($false, 'Local\CodexWebGptLocalProductionStartup')
try { $startupLockHeld = $startupMutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $startupLockHeld = $true }
if (-not $startupLockHeld) {
  Write-Output 'Local production startup is already in progress.'
  exit 0
}
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repoRoot 'run-local-production.cmd'
$logDir = Join-Path $repoRoot 'work\local-production'
$launcherEntry = Join-Path $repoRoot 'launcher'
$devSpaceLogDir = Join-Path $repoRoot 'work\devspace'
$nativeGateway = Join-Path $PSScriptRoot 'devspace-native-gateway.mjs'

if (-not (Test-Path -LiteralPath $runner)) {
  throw "Local production runner was not found: $runner"
}

# Start DevSpace before the Electron launcher so the local MCP server is available
# whenever this production shortcut is used. A running DevSpace process is reused.
function Start-DevSpaceIfNeeded {
  . (Join-Path $PSScriptRoot 'devspace-settings.ps1')
  $settings = Get-DevSpaceSettings
  $port = $settings.Port
  $gatewayPattern = [Regex]::Escape($nativeGateway)
  $isListening = {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
      Select-Object -First 1
    if ($null -eq $listener) { return $false }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
    if ($owner.Name -ine 'node.exe' -or ($owner.CommandLine -notmatch '@waishnav[\\/]devspace[\\/]dist[\\/]cli\.js"?\s+serve' -and $owner.CommandLine -notmatch $gatewayPattern)) {
      throw "Port $port is owned by another service; it was not stopped."
    }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
      $modeMatches = if ($DevSpaceToolMode -eq 'native') { $health.mode -eq 'native' } else { $health.mode -ne 'native' }
      return $health.ok -eq $true -and $health.name -eq 'devspace' -and $modeMatches
    } catch { return $false }
  }
  $existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -ieq 'node.exe' -and
      ($_.CommandLine -match '@waishnav[\\/]devspace[\\/]dist[\\/]cli\.js"?\s+serve' -or $_.CommandLine -match $gatewayPattern)
    } |
    Select-Object -First 1

  if (& $isListening) {
    Write-Output "DevSpace is already running and healthy on port $port."
    return
  }

  if ($null -ne $existing) {
    # Recheck immediately before stopping: startup may have completed during discovery.
    if (& $isListening) { return }
    Write-Output "Restarting DevSpace to recover health or apply tool mode $DevSpaceToolMode (PID $($existing.ProcessId))."
    Stop-Process -Id $existing.ProcessId -ErrorAction Stop
    Wait-Process -Id $existing.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  }

  $devSpaceCommand = Get-Command 'devspace.cmd' -ErrorAction Stop
  New-Item -ItemType Directory -Force -Path $devSpaceLogDir | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $devSpaceLogDir "serve-$stamp.stdout.log"
  $stderr = Join-Path $devSpaceLogDir "serve-$stamp.stderr.log"
  $previousToolMode = $env:DEVSPACE_TOOL_MODE
  $gatewayEnvironment = @{}
  try {
    $env:DEVSPACE_TOOL_MODE = if ($DevSpaceToolMode -eq 'native') { 'codex' } else { $DevSpaceToolMode }
    $executable = $devSpaceCommand.Source
    $arguments = 'serve'
    if ($DevSpaceToolMode -eq 'native') {
      $packagedBun = Join-Path $env:ProgramFiles 'Codex Web GPT\resources\runtime\runtime\bun.exe'
      $gatewayValues = @{
        DEVSPACE_MODULE_DIR = Join-Path (Split-Path -Parent $devSpaceCommand.Source) 'node_modules\@waishnav\devspace'
        CODEX_WEB_GPT_BUN = if (Test-Path -LiteralPath $packagedBun) { $packagedBun } else { (Get-Command bun.exe -ErrorAction Stop).Source }
        CODEX_CHATGPT_WEB_HOME = Join-Path $env:USERPROFILE '.codex-chatgpt-web'
      }
      foreach ($entry in $gatewayValues.GetEnumerator()) {
        $gatewayEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
      }
      $executable = (Get-Command node.exe -ErrorAction Stop).Source
      $arguments = '"' + $nativeGateway + '"'
    }
    $process = Start-Process -FilePath $executable -ArgumentList $arguments `
      -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr -PassThru
  } finally {
    foreach ($entry in $gatewayEnvironment.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    if ($null -eq $previousToolMode) { Remove-Item Env:DEVSPACE_TOOL_MODE -ErrorAction SilentlyContinue }
    else { $env:DEVSPACE_TOOL_MODE = $previousToolMode }
  }

  for ($attempt = 1; $attempt -le 15; $attempt++) {
    if (& $isListening) {
      Write-Output "DevSpace started silently (PID $($process.Id), port $port, tool mode $DevSpaceToolMode)."
      return
    }
    Start-Sleep -Seconds 1
  }

  throw "DevSpace did not become healthy on 127.0.0.1:$port. Check: $stderr"
}

function Start-DevSpaceIntegration {
  New-Item -ItemType Directory -Force -Path $devSpaceLogDir | Out-Null
  $integrationLog = Join-Path $devSpaceLogDir 'startup.log'
  Add-Content -LiteralPath $integrationLog -Value "$(Get-Date -Format o) Starting DevSpace/Tailscale integration."
  try {
    Start-DevSpaceIfNeeded | ForEach-Object { Add-Content -LiteralPath $integrationLog -Value $_ -Encoding UTF8; Write-Output $_ }
    & (Join-Path $PSScriptRoot 'ensure-devspace-tunnel.ps1') | ForEach-Object { Add-Content -LiteralPath $integrationLog -Value $_ -Encoding UTF8; Write-Output $_ }
  } catch {
    Add-Content -LiteralPath $integrationLog -Value "$(Get-Date -Format o) FAILED: $($_.Exception.Message)"
    if ($IntegrationWorker) {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.MessageBox]::Show("O aplicativo pode ser usado, mas a integracao DevSpace falhou: $($_.Exception.Message)`n`nLog: $integrationLog", 'Codex Web GPT', 'OK', 'Warning') | Out-Null
      exit 1
    }
    if ($DevSpaceOnly) { throw }
    Write-Warning "DevSpace integration is not ready: $($_.Exception.Message)"
  }
}

if ($DevSpaceOnly -or $IntegrationWorker) {
  Start-DevSpaceIntegration
  exit 0
}

function Start-IntegrationInBackground {
  $powershell = (Get-Process -Id $PID).Path
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-IntegrationWorker', '-DevSpaceToolMode', $DevSpaceToolMode)
  Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
}

# A fresh launcher avoids stale Electron renderer, GPU, and helper processes from
# the same repository. The repository path keeps unrelated Electron applications
# and the Codex desktop process out of scope.
$escapedLauncherEntry = [Regex]::Escape($launcherEntry)
$escapedRepoRoot = [Regex]::Escape($repoRoot)
$existingLaunchers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -ieq 'electron.exe' -and
    ($_.CommandLine -match $escapedLauncherEntry -or $_.CommandLine -match $escapedRepoRoot)
  }

if ($existingLaunchers) {
  try {
    $runtimeHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17841/healthz' -TimeoutSec 3
  } catch { $runtimeHealth = $null }
  if ($runtimeHealth.status -eq 'ok' -and $runtimeHealth.accepting_turns -eq $true) {
    Start-IntegrationInBackground
    $electron = Join-Path $launcherEntry 'node_modules\electron\dist\electron.exe'
    if (Test-Path -LiteralPath $electron) {
      Start-Process -FilePath $electron -ArgumentList ('"' + $launcherEntry + '"') -WorkingDirectory $launcherEntry | Out-Null
    }
    Write-Output 'The existing local production launcher and bridge are healthy; they were reused.'
    exit 0
  }
  # The existing restart worker owns process-tree cleanup and waits for active turns.
  & (Join-Path $PSScriptRoot 'restart-local-production-safe.ps1')
  exit 0
}

$viteListener = Get-NetTCPConnection -LocalPort 4178 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($viteListener) {
  $ownerId = $viteListener.OwningProcess
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show("O aplicativo nao pode iniciar porque a porta 4178 esta em uso (PID $ownerId). Feche o processo responsavel e tente novamente.", 'Codex Web GPT', 'OK', 'Error') | Out-Null
  exit 1
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
  $env:CODEX_WEB_GPT_START_HIDDEN = '0'
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $runner) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr -PassThru
} finally {
  if ($null -eq $priorSilent) { Remove-Item Env:CODEX_WEB_GPT_SILENT -ErrorAction SilentlyContinue }
  else { $env:CODEX_WEB_GPT_SILENT = $priorSilent }
  if ($null -eq $priorStartHidden) { Remove-Item Env:CODEX_WEB_GPT_START_HIDDEN -ErrorAction SilentlyContinue }
  else { $env:CODEX_WEB_GPT_START_HIDDEN = $priorStartHidden }
}

Start-IntegrationInBackground
# Surface immediate runner failures (missing dependencies, occupied Vite port, etc.).
if ($process.WaitForExit(45000)) {
  $code = $process.ExitCode
  if ($code -ne 0) {
    $details = @($stdout, $stderr | ForEach-Object { if (Test-Path -LiteralPath $_) { Get-Content -LiteralPath $_ -Tail 12 } }) -join "`n"
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("O aplicativo nao iniciou (codigo $code).`n$details`n`nLog: $stderr", 'Codex Web GPT', 'OK', 'Error') | Out-Null
    exit $code
  }
}
Write-Output "Local production launcher started silently (PID $($process.Id))."
Write-Output "Logs: $stdout"

if ($Wait) {
  $process.WaitForExit()
  exit $process.ExitCode
}
