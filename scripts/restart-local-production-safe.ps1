param(
  [switch]$Worker,
  [switch]$RunImageSmoke,
  [int]$TimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repoRoot 'run-local-production.cmd'
$healthUrl = 'http://127.0.0.1:17841/healthz'
$logDir = Join-Path $repoRoot 'work\safe-restart'
$logPath = Join-Path $logDir 'latest.log'

if (-not $Worker) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $pwsh = (Get-Process -Id $PID).Path
  $workerArguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $PSCommandPath,
    '-Worker',
    '-TimeoutMinutes', [string]$TimeoutMinutes
  )
  if ($RunImageSmoke) { $workerArguments += '-RunImageSmoke' }
  Start-Process -FilePath $pwsh -WindowStyle Hidden -ArgumentList $workerArguments -WorkingDirectory $repoRoot | Out-Null
  Write-Output "Safe restart queued. It will run after active Codex Web turns finish. Log: $logPath"
  exit 0
}

function Write-RestartLog([string]$Message) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message"
}

function Get-LauncherRootProcess {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'bun.exe' -and
      $_.CommandLine -match 'run scripts/dev\.cjs' -and
      $_.CommandLine -notmatch 'restart-local-production-safe'
    } |
    Sort-Object CreationDate -Descending |
    Select-Object -First 1
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

Write-RestartLog 'Waiting for the Codex Web runtime to become idle.'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.active_http_turns -eq 0 -and $health.active_browser_turns -eq 0) { break }
    Write-RestartLog "Still active: http=$($health.active_http_turns) browser=$($health.active_browser_turns)."
  } catch {
    Write-RestartLog "Health unavailable while waiting: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 2
}

if ((Get-Date) -ge $deadline) {
  Write-RestartLog 'Timed out without an idle window; no process was stopped.'
  exit 1
}

$rootProcess = Get-LauncherRootProcess
$ownedLauncherConsoles = @(Get-OwnedLauncherConsoleProcesses)
if ($rootProcess) {
  Write-RestartLog "Stopping idle launcher tree rooted at PID $($rootProcess.ProcessId)."
  Stop-ProcessTree -RootPid ([int]$rootProcess.ProcessId)
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

Write-RestartLog 'Starting a fresh visible local-production launcher.'
# /c keeps the console visible while the foreground launcher runs, but lets that console close with
# its runtime.  /k left an empty window behind every time the Bun child tree was replaced.
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $runner) -WorkingDirectory $repoRoot | Out-Null

$readyDeadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $readyDeadline) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.status -eq 'ok' -and $health.accepting_turns -eq $true) {
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
  } catch {}
  Start-Sleep -Seconds 2
}

Write-RestartLog 'The replacement launcher did not become healthy within 90 seconds.'
exit 1
