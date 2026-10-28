param(
  [switch]$Worker,
  [switch]$Force,
  [switch]$RunImageSmoke,
  [switch]$MemorySaver,
  [switch]$PreserveOpenCodex,
  [int]$TimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repoRoot 'run-local-production.cmd'
$silentRunner = Join-Path $repoRoot 'scripts\start-local-production-silent.ps1'
$healthUrl = 'http://127.0.0.1:17841/healthz'
$supervisorPath = Join-Path $env:USERPROFILE '.codex-chatgpt-web\runtime\launcher-supervisor.json'
$logDir = Join-Path $repoRoot 'work\safe-restart'
$logPath = Join-Path $logDir 'latest.log'

if (-not $Worker) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $pwsh = (Get-Process -Id $PID).Path
  $workerArguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'),
    '-Worker',
    '-TimeoutMinutes', [string]$TimeoutMinutes
  )
  if ($RunImageSmoke) { $workerArguments += '-RunImageSmoke' }
  if ($Force) { $workerArguments += '-Force' }
  if ($MemorySaver) { $workerArguments += '-MemorySaver' }
  if ($PreserveOpenCodex) { $workerArguments += '-PreserveOpenCodex' }
  Start-Process -FilePath $pwsh -WindowStyle Hidden -ArgumentList $workerArguments -WorkingDirectory $repoRoot | Out-Null
  Write-Output "Safe restart queued. It will run after active Codex Web turns finish. Log: $logPath"
  exit 0
}

$restartMutex = [Threading.Mutex]::new($false, 'Local\CodexWebGptLocalProductionRecovery')
try { $restartLockHeld = $restartMutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $restartLockHeld = $true }
if (-not $restartLockHeld) {
  Write-Output 'Local production recovery is already in progress.'
  exit 0
}

function Write-RestartLog([string]$Message) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message"
}

function Get-LauncherRootProcesses {
  $all = @(Get-CimInstance Win32_Process)
  $roots = [System.Collections.Generic.Dictionary[int, object]]::new()
  if (Test-Path -LiteralPath $supervisorPath) {
    try {
      $supervisor = Get-Content -Raw -LiteralPath $supervisorPath | ConvertFrom-Json
      if ($supervisor.ownerPid -is [int] -or $supervisor.ownerPid -is [long]) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$supervisor.ownerPid)" -ErrorAction SilentlyContinue
        $ownedChild = $all | Where-Object {
          $_.ParentProcessId -eq $owner.ProcessId -and
          $_.CommandLine -match [regex]::Escape((Join-Path $repoRoot 'launcher'))
        } | Select-Object -First 1
        if ($owner -and $ownedChild -and ($owner.Name -eq 'bun.exe' -or $owner.Name -eq 'Codex Web GPT.exe')) {
          $roots[[int]$owner.ProcessId] = $owner
        }
      }
    } catch {
      Write-RestartLog "Could not resolve the supervisor owner: $($_.Exception.Message)"
    }
  }
  # A previous launcher can lose ownership of the supervisor file while its Electron tree and
  # console remain alive. Find every dev supervisor whose direct Electron child belongs to this
  # exact checkout, so a restart cannot leave two local-production instances competing.
  $escapedLauncher = [regex]::Escape((Join-Path $repoRoot 'launcher'))
  foreach ($candidate in $all | Where-Object {
    $_.Name -eq 'bun.exe' -and $_.CommandLine -match 'run scripts/dev\.cjs'
  }) {
    $ownsThisCheckout = $all | Where-Object {
      $_.ParentProcessId -eq $candidate.ProcessId -and
      $_.Name -eq 'electron.exe' -and
      $_.CommandLine -match $escapedLauncher
    } | Select-Object -First 1
    if ($ownsThisCheckout) { $roots[[int]$candidate.ProcessId] = $candidate }
  }
  @($roots.Values)
}

function Get-OwnedLauncherConsoleProcesses {
  $escapedRunner = [regex]::Escape($runner)
  @(Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'cmd.exe' -and
      $_.CommandLine -match $escapedRunner
    })
}

function Stop-ProcessTree([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process)
  $children = @{}
  foreach ($process in $all) {
    if (-not $children.ContainsKey([int]$process.ParentProcessId)) {
      $children[[int]$process.ParentProcessId] = [System.Collections.Generic.List[int]]::new()
    }
    $children[[int]$process.ParentProcessId].Add([int]$process.ProcessId)
  }
  $ordered = [System.Collections.Generic.List[int]]::new()
  function Visit([int]$CurrentProcessId) {
    if ($CurrentProcessId -eq $PID) { return }
    if ($children.ContainsKey($CurrentProcessId)) {
      foreach ($child in $children[$CurrentProcessId]) { Visit $child }
    }
    $ordered.Add($CurrentProcessId)
  }
  Visit $RootPid
  foreach ($processId in $ordered) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

function Get-CodexDesktopRootProcesses {
  $all = @(Get-CimInstance Win32_Process)
  $desktopProcesses = @($all | Where-Object {
    $_.Name -in @('ChatGPT.exe', 'Codex.exe') -and
    $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$'
  })
  $desktopPids = @($desktopProcesses | ForEach-Object { $_.ProcessId })
  @($desktopProcesses | Where-Object {
    $_.CommandLine -notmatch '(?:^|\s)--type=' -and
    $_.ParentProcessId -notin $desktopPids
  })
}

Write-RestartLog 'Waiting for the Codex Web runtime to become idle.'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$consecutiveHealthFailures = 0
while (-not $Force -and (Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    $consecutiveHealthFailures = 0
    if ($health.active_http_turns -eq 0 -and $health.active_browser_turns -eq 0) { break }
    Write-RestartLog "Still active: http=$($health.active_http_turns) browser=$($health.active_browser_turns)."
  } catch {
    $consecutiveHealthFailures++
    Write-RestartLog "Health unavailable while waiting: $($_.Exception.Message)"
    if ($consecutiveHealthFailures -ge 3) {
      Write-RestartLog 'Three consecutive health failures; recovering the unresponsive owned launcher/runtime.'
      break
    }
  }
  Start-Sleep -Seconds 2
}

if (-not $Force -and (Get-Date) -ge $deadline) {
  Write-RestartLog 'Timed out without an idle window; no process was stopped.'
  exit 1
}

if ($Force) {
  Write-RestartLog 'Forced restart requested by the user; stopping the current launcher despite active turns.'
}

$rootProcesses = @(Get-LauncherRootProcesses)
$ownedLauncherConsoles = @(Get-OwnedLauncherConsoleProcesses)
$codexDesktopRoots = @(Get-CodexDesktopRootProcesses)
# Capture the installed GUI entry before stopping it; never launch the CLI bin/codex.exe.
$codexDesktopEntries = @($codexDesktopRoots | Select-Object -ExpandProperty ExecutablePath -Unique)
foreach ($desktopRoot in $codexDesktopRoots) {
  Write-RestartLog "Stopping Codex Desktop tree PID $($desktopRoot.ProcessId)."
  Stop-ProcessTree -RootPid ([int]$desktopRoot.ProcessId)
}
if ($rootProcesses.Count -gt 0) {
  $rootPids = ($rootProcesses | ForEach-Object { [string]$_.ProcessId }) -join ', '
  Write-RestartLog "Stopping $($rootProcesses.Count) idle launcher tree(s), rooted at PID(s): $rootPids."
  foreach ($rootProcess in $rootProcesses) {
    Stop-ProcessTree -RootPid ([int]$rootProcess.ProcessId)
  }
  Start-Sleep -Seconds 1
}

if ($ownedLauncherConsoles.Count -gt 0) {
  $consolePids = ($ownedLauncherConsoles | ForEach-Object { [string]$_.ProcessId }) -join ', '
  Write-RestartLog "Closing $($ownedLauncherConsoles.Count) launcher console(s): $consolePids."
  foreach ($console in $ownedLauncherConsoles) {
    Stop-Process -Id ([int]$console.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}

# Restart the exact OpenCodex web runner and this checkout's native gateway.
# Tailscale is shared infrastructure: the startup integration verifies its route.
$openCodexEntry = Join-Path (Split-Path -Parent $repoRoot) 'OpenCodex\gateway\dev\run-gateway.cjs'
$nativeGatewayEntry = Join-Path $PSScriptRoot 'devspace-native-gateway.mjs'
$companionRoots = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq 'node.exe' -and (
    (-not $PreserveOpenCodex -and $_.CommandLine -match [regex]::Escape($openCodexEntry)) -or
    $_.CommandLine -match [regex]::Escape($nativeGatewayEntry)
  )
})
if ($PreserveOpenCodex) { Write-RestartLog 'Codex worker reset: preserving the OpenCodex service and its process tree.' }
foreach ($companion in $companionRoots) {
  Write-RestartLog "Stopping companion service tree PID $($companion.ProcessId)."
  Stop-ProcessTree -RootPid ([int]$companion.ProcessId)
}

$electronPackagePath = Join-Path $repoRoot 'launcher\node_modules\electron\package.json'
$electronVersionPath = Join-Path $repoRoot 'launcher\node_modules\electron\dist\version'
if (Test-Path -LiteralPath $electronPackagePath) {
  $expectedElectronVersion = (Get-Content -Raw -LiteralPath $electronPackagePath | ConvertFrom-Json).version
  $installedElectronVersion = if (Test-Path -LiteralPath $electronVersionPath) {
    (Get-Content -Raw -LiteralPath $electronVersionPath).Trim().TrimStart('v')
  } else { '' }
  if ($installedElectronVersion -ne $expectedElectronVersion) {
    Write-RestartLog "Installing Electron $expectedElectronVersion after releasing the old launcher files."
    $taskBun = (Get-Command bun -ErrorAction Stop).Source
    & $taskBun (Join-Path $repoRoot 'launcher\node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) { throw 'Electron installation failed before restarting the launcher.' }
  }
}

if ($MemorySaver) {
  $statePath = Join-Path $env:APPDATA 'Codex Web GPT\launcher-state.json'
  if (-not (Test-Path -LiteralPath $statePath)) { throw 'Launcher state was not found.' }
  $launcherState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  $launcherState | Add-Member -NotePropertyName memorySaver -NotePropertyValue $true -Force
  $temporaryState = "$statePath.memory-saver.tmp"
  [IO.File]::WriteAllText($temporaryState, ($launcherState | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryState -Destination $statePath -Force
  Write-RestartLog 'Memory saver enabled for the replacement launcher.'
}

Write-RestartLog 'Starting a fresh silent local-production launcher.'
foreach ($desktopEntry in $codexDesktopEntries) {
  Write-RestartLog "Starting Codex Desktop: $desktopEntry"
  Start-Process -FilePath $desktopEntry -WindowStyle Hidden | Out-Null
}
# The dedicated wrapper retains startup output in work/local-production while preventing an
# interactive cmd.exe from flashing or lingering after Bun/Electron exits.
Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $silentRunner + '"')
) -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null

$readyDeadline = (Get-Date).AddSeconds(240)
$lastReadinessError = ''
while ((Get-Date) -lt $readyDeadline) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.status -eq 'ok' -and $health.accepting_turns -eq $true) {
      $openCodexHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3737/api/health' -TimeoutSec 3
      if ($openCodexHealth.gateway.projectRoot -ine (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $openCodexEntry))) -or $openCodexHealth.officialIpc.ready -ne $true) {
        throw 'OpenCodex runtime is not ready.'
      }
      . (Join-Path $PSScriptRoot 'devspace-settings.ps1')
      $devSpaceSettings = Get-DevSpaceSettings -IgnoreInheritedPort
      $devSpaceHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$($devSpaceSettings.Port)/healthz" -TimeoutSec 3
      if ($devSpaceHealth.ok -ne $true -or $devSpaceHealth.name -ne 'devspace' -or $devSpaceHealth.mode -ne 'native') { throw 'Native DevSpace is not ready.' }
      $readinessCallerPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
      try {
        $env:PORT = [string]$devSpaceSettings.Port
        & (Join-Path $PSScriptRoot 'ensure-devspace-tunnel.ps1') -VerifyOnly | ForEach-Object { Write-RestartLog $_ }
      } finally {
        [Environment]::SetEnvironmentVariable('PORT', $readinessCallerPort, 'Process')
      }
      Write-RestartLog "Restart completed: pid=$($health.pid) version=$($health.version)."
      if (-not $RunImageSmoke) { exit 0 }
      $descriptorPath = Join-Path $env:USERPROFILE '.codex-chatgpt-web\runtime\launcher-browser.json'
      $descriptorDeadline = (Get-Date).AddSeconds(30)
      while (!(Test-Path -LiteralPath $descriptorPath) -and (Get-Date) -lt $descriptorDeadline) {
        Start-Sleep -Milliseconds 500
      }
      $descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
      $outputDir = Join-Path $repoRoot 'work\image-handoff'
      New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
      $outputPath = Join-Path $outputDir "apple-codex-web-smoke-$(Get-Date -Format 'yyyyMMdd-HHmmss').png"
      $headers = @{ Authorization = "Bearer $($descriptor.control.token)" }
      $body = @{
        traceId = 'apple_product_safe_restart_smoke'
        prompt = 'Generate one polished photorealistic e-commerce product image of exactly one fresh red apple, centered, isolated on a genuinely transparent background, soft studio lighting, no text, no logo, no watermark, no props, no additional fruit.'
        outputPath = $outputPath
      } | ConvertTo-Json -Compress
      $generated = Invoke-RestMethod -Method Post -Uri "$($descriptor.control.endpoint)/v1/image/generate" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 360
      if ($generated.ok -ne $true -or !(Test-Path -LiteralPath $outputPath)) {
        throw 'Post-restart ChatGPT Web image smoke test did not produce its PNG.'
      }
      Write-RestartLog "Image smoke passed: $outputPath ($($generated.width)x$($generated.height), $($generated.bytes) bytes)."
      exit 0
    }
  } catch {
    $readinessError = $_.Exception.Message
    if ($readinessError -ne $lastReadinessError) {
      Write-RestartLog "Still waiting for service readiness: $readinessError"
      $lastReadinessError = $readinessError
    }
  }
  Start-Sleep -Seconds 2
}

Write-RestartLog 'The launcher, OpenCodex or DevSpace integration did not become ready within 240 seconds.'
exit 1
