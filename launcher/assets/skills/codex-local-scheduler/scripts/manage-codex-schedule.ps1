[CmdletBinding()]
param(
    [ValidateSet("Create", "List", "Status", "Run", "RunNow", "Remove")]
    [string]$Action = "Create",
    [string]$Name,
    [string]$ThreadId = $env:CODEX_THREAD_ID,
    [string]$Message,
    [datetime]$At = [datetime]::MinValue,
    [ValidateRange(0, 525600)]
    [int]$DelayMinutes = 0,
    [ValidateSet("Once", "Daily", "Weekly")]
    [string]$Frequency = "Once",
    [ValidateSet("Resume", "Queue")]
    [string]$Mode = "Resume",
    [switch]$NativeCodex,
    [string[]]$DaysOfWeek = @(),
    [string]$WorkingDirectory,
    [ValidateSet("read-only", "workspace-write", "danger-full-access")]
    [string]$Sandbox = "read-only",
    [string]$Model,
    [ValidateSet("low", "medium", "high", "xhigh", "max")]
    [string]$ReasoningEffort,
    [string]$Profile,
    [ValidateRange(1, 20)]
    [int]$RetryCount = 6,
    [ValidateRange(1, 600)]
    [int]$RetryDelaySeconds = 20,
    [string]$StateRoot,
    [string]$DefinitionPath,
    [string]$CodexPath,
    [string[]]$CodexPrefixArguments = @(),
    [switch]$ApproveForMe,
    [switch]$Replace,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = (Get-Location).Path
}
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($userProfile)) {
        throw "User profile directory is unavailable"
    }
    $StateRoot = Join-Path $userProfile ".codex\local-scheduler"
}

function ConvertTo-SafeName {
    param([Parameter(Mandatory)][string]$Value)
    $safe = ($Value.Trim().ToLowerInvariant() -replace '[^a-z0-9._-]+', '-').Trim([char[]]"-.")
    if ([string]::IsNullOrWhiteSpace($safe)) {
        throw "Schedule name must contain at least one letter or number"
    }
    if ($safe.Length -gt 80) {
        $safe = $safe.Substring(0, 80).TrimEnd([char[]]"-.")
    }
    return $safe
}

function Resolve-CodexPath {
    param([string]$RequestedPath)
    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) {
            throw "Codex executable was not found: $RequestedPath"
        }
        return (Resolve-Path -LiteralPath $RequestedPath).Path
    }
    $command = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Codex CLI was not found in PATH"
    }
    return $command.Source
}

function Get-JobPaths {
    param([Parameter(Mandatory)][string]$ScheduleName)
    $safeName = ConvertTo-SafeName $ScheduleName
    return [pscustomobject]@{
        SafeName = $safeName
        Definition = Join-Path (Join-Path $StateRoot "jobs") "$safeName.json"
        Log = Join-Path (Join-Path $StateRoot "logs") "$safeName.jsonl"
        TaskName = "Codex Local Scheduler - $safeName"
    }
}

function Save-Definition {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Definition
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    $Definition.updatedAt = (Get-Date).ToString("o")
    $Definition | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-Definition {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Schedule definition was not found: $Path"
    }
    $definition = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($definition.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string]$definition.threadId) -or [string]::IsNullOrWhiteSpace([string]$definition.message)) {
        throw "Schedule definition is invalid: $Path"
    }
    return $definition
}

function Write-JobLog {
    param(
        [Parameter(Mandatory)]$Definition,
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)][int]$Attempt,
        [Parameter(Mandatory)][int]$ExitCode,
        [string]$Output
    )
    $directory = Split-Path -Parent $Definition.logPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        status = $Status
        attempt = $Attempt
        exitCode = $ExitCode
        output = $Output
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $Definition.logPath -Encoding UTF8
}

function Resolve-DefinitionPath {
    if (-not [string]::IsNullOrWhiteSpace($DefinitionPath)) {
        return $DefinitionPath
    }
    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "Name or DefinitionPath is required"
    }
    return (Get-JobPaths $Name).Definition
}

function Invoke-NativeProcess {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Directory
    )
    if ($PSVersionTable.PSEdition -ne "Core") {
        throw "PowerShell 7 or newer is required to run scheduled Codex prompts"
    }
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $Directory
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start Codex CLI"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult().TrimEnd()
    $stderr = $stderrTask.GetAwaiter().GetResult().TrimEnd()
    $output = @($stdout, $stderr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = $output -join [Environment]::NewLine
    }
}

function Get-TaskState {
    param([Parameter(Mandatory)]$Definition)
    $task = Get-ScheduledTask -TaskName $Definition.taskName -ErrorAction SilentlyContinue
    $info = if ($task) { Get-ScheduledTaskInfo -TaskName $Definition.taskName -ErrorAction SilentlyContinue } else { $null }
    return [pscustomobject]@{
        name = $Definition.name
        taskName = $Definition.taskName
        threadId = $Definition.threadId
        mode = if ($Definition.PSObject.Properties.Name -contains "mode") { $Definition.mode } else { "Resume" }
        nativeCodex = if ($Definition.PSObject.Properties.Name -contains "nativeCodex") { [bool]$Definition.nativeCodex } else { $false }
        frequency = $Definition.frequency
        scheduledAt = $Definition.scheduledAt
        timezone = $Definition.timezone
        status = $Definition.status
        registered = [bool]$task
        taskState = if ($task) { [string]$task.State } else { "NotRegistered" }
        nextRunTime = if ($info -and $info.NextRunTime -gt [datetime]::MinValue) { $info.NextRunTime.ToString("o") } else { $null }
        lastRunTime = if ($info -and $info.LastRunTime -gt [datetime]::MinValue) { $info.LastRunTime.ToString("o") } else { $Definition.lastRunAt }
        lastTaskResult = if ($info) { $info.LastTaskResult } else { $Definition.lastExitCode }
        definitionPath = $Definition.definitionPath
        logPath = $Definition.logPath
    }
}

function Invoke-CodexSchedule {
    param([Parameter(Mandatory)][string]$Path)
    $definition = Read-Definition $Path
    $executionMode = if ($definition.PSObject.Properties.Name -contains "mode") { [string]$definition.mode } else { "Resume" }
    $nativeCodex = $definition.PSObject.Properties.Name -contains "nativeCodex" -and $definition.nativeCodex -eq $true
    $codexArgs = @()
    if ($definition.PSObject.Properties.Name -contains "codexPrefixArguments") {
        $codexArgs += @($definition.codexPrefixArguments | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    }
    if ($executionMode -eq "Resume") {
        $codexArgs += @("exec", "resume")
        if ($nativeCodex) {
            $codexArgs += "--ignore-user-config"
        }
        $codexArgs += "--json"
        if (-not [string]::IsNullOrWhiteSpace([string]$definition.model)) {
            $codexArgs += @("-m", [string]$definition.model)
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$definition.reasoningEffort)) {
            $codexArgs += @("-c", "model_reasoning_effort=`"$($definition.reasoningEffort)`"")
        }
        $codexArgs += @([string]$definition.threadId, [string]$definition.message)
    } else {
        $codexArgs += @(
            "queue",
            "--thread", [string]$definition.threadId,
            "--message", [string]$definition.message,
            "-C", [string]$definition.workingDirectory,
            "-s", [string]$definition.sandbox
        )
        if (-not [string]::IsNullOrWhiteSpace([string]$definition.model)) {
            $codexArgs += @("-m", [string]$definition.model)
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$definition.reasoningEffort)) {
            $codexArgs += @("-c", "model_reasoning_effort=`"$($definition.reasoningEffort)`"")
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$definition.profile)) {
            $codexArgs += @("-p", [string]$definition.profile)
        }
        if ($definition.approveForMe -eq $true) {
            $codexArgs += "--approve-for-me"
        }
    }
    if ($DryRun) {
        [pscustomobject]@{
            dryRun = $true
            executable = $definition.codexPath
            arguments = $codexArgs
            definitionPath = $Path
        } | ConvertTo-Json -Depth 6 -Compress
        return
    }
    Write-JobLog -Definition $definition -Status "started" -Attempt 0 -ExitCode 0 -Output ""
    $success = $false
    $lastExitCode = -1
    $lastOutput = ""
    for ($attempt = 1; $attempt -le [int]$definition.retryCount; $attempt++) {
        $outputLines = @()
        try {
            $result = Invoke-NativeProcess -Executable $definition.codexPath -Arguments $codexArgs -Directory $definition.workingDirectory
            $outputLines = @($result.Output)
            $lastExitCode = [int]$result.ExitCode
        } catch {
            $outputLines = @($_.Exception.Message.Trim())
            $lastExitCode = -1
        }
        $lastOutput = ($outputLines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        $successStatus = if ($executionMode -eq "Resume") { "completed" } else { "queued" }
        $turnStarted = $executionMode -eq "Resume" -and $lastOutput -match '"type"\s*:\s*"turn\.started"'
        $attemptStatus = if ($lastExitCode -eq 0) { $successStatus } elseif ($turnStarted) { "failed" } else { "retry" }
        Write-JobLog -Definition $definition -Status $attemptStatus -Attempt $attempt -ExitCode $lastExitCode -Output $lastOutput
        if ($lastExitCode -eq 0) {
            $success = $true
            break
        }
        if ($turnStarted) {
            break
        }
        if ($attempt -lt [int]$definition.retryCount) {
            Start-Sleep -Seconds ([int]$definition.retryDelaySeconds)
        }
    }
    $definition.lastRunAt = (Get-Date).ToString("o")
    $definition.lastExitCode = $lastExitCode
    $definition.lastOutput = $lastOutput
    $definition.status = if ($success) { if ($executionMode -eq "Resume") { "completed" } else { "queued" } } else { "failed" }
    Save-Definition -Path $Path -Definition $definition
    if (-not $success) {
        throw "Codex $executionMode failed. See $($definition.logPath)"
    }
    if ($definition.frequency -eq "Once") {
        Unregister-ScheduledTask -TaskName $definition.taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-TaskState $definition | ConvertTo-Json -Depth 6 -Compress
}

function New-Schedule {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "Codex Local Scheduler currently supports Windows only"
    }
    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "Name is required"
    }
    if ([string]::IsNullOrWhiteSpace($ThreadId)) {
        throw "ThreadId is required. Run this skill inside a Codex task or pass an exact task id or name"
    }
    if ($ThreadId.Contains("`r") -or $ThreadId.Contains("`n")) {
        throw "ThreadId must be a single line"
    }
    if ([string]::IsNullOrWhiteSpace($Message)) {
        throw "Message is required"
    }
    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
        throw "Working directory was not found: $WorkingDirectory"
    }
    $paths = Get-JobPaths $Name
    if ((Test-Path -LiteralPath $paths.Definition) -and -not $Replace) {
        throw "Schedule already exists: $($paths.SafeName). Use -Replace to update it"
    }
    if ($DelayMinutes -gt 0) {
        $At = (Get-Date).AddMinutes($DelayMinutes)
    }
    if ($At -eq [datetime]::MinValue) {
        throw "At or DelayMinutes is required"
    }
    if ($Frequency -eq "Once" -and $At -le (Get-Date)) {
        throw "A one-time schedule must run in the future"
    }
    if ($Frequency -eq "Weekly" -and $DaysOfWeek.Count -eq 0) {
        throw "DaysOfWeek is required for a weekly schedule"
    }
    if ($Mode -eq "Resume" -and (-not [string]::IsNullOrWhiteSpace($Profile) -or $ApproveForMe)) {
        throw "Profile and ApproveForMe apply only to Queue mode; Resume preserves the target task configuration"
    }
    if ($NativeCodex -and $Mode -ne "Resume") {
        throw "NativeCodex requires Resume mode"
    }
    if ($NativeCodex -and -not [string]::IsNullOrWhiteSpace($Model) -and $Model.StartsWith("chatgpt-web/", [StringComparison]::OrdinalIgnoreCase)) {
        throw "NativeCodex cannot use a chatgpt-web model"
    }
    $validDays = [System.DayOfWeek].GetEnumNames()
    foreach ($day in $DaysOfWeek) {
        if ($validDays -notcontains $day) {
            throw "Invalid day of week: $day"
        }
    }
    $resolvedCodex = Resolve-CodexPath $CodexPath
    $definition = [pscustomobject]@{
        schemaVersion = 1
        name = $paths.SafeName
        displayName = $Name
        taskName = $paths.TaskName
        threadId = $ThreadId
        mode = $Mode
        nativeCodex = [bool]$NativeCodex
        message = $Message
        workingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
        sandbox = $Sandbox
        approveForMe = [bool]$ApproveForMe
        model = if ([string]::IsNullOrWhiteSpace($Model)) { $null } else { $Model }
        reasoningEffort = if ([string]::IsNullOrWhiteSpace($ReasoningEffort)) { $null } else { $ReasoningEffort }
        profile = if ([string]::IsNullOrWhiteSpace($Profile)) { $null } else { $Profile }
        frequency = $Frequency
        daysOfWeek = @($DaysOfWeek)
        scheduledAt = $At.ToString("o")
        timezone = [TimeZoneInfo]::Local.Id
        retryCount = $RetryCount
        retryDelaySeconds = $RetryDelaySeconds
        codexPath = $resolvedCodex
        codexPrefixArguments = @($CodexPrefixArguments)
        scriptPath = $PSCommandPath
        definitionPath = $paths.Definition
        logPath = $paths.Log
        createdAt = (Get-Date).ToString("o")
        updatedAt = (Get-Date).ToString("o")
        status = "scheduled"
        lastRunAt = $null
        lastExitCode = $null
        lastOutput = $null
    }
    $previous = if (Test-Path -LiteralPath $paths.Definition) { Get-Content -LiteralPath $paths.Definition -Raw } else { $null }
    try {
        Save-Definition -Path $paths.Definition -Definition $definition
        if (-not $DryRun) {
            $shellCommand = Get-Command pwsh -ErrorAction SilentlyContinue
            if (-not $shellCommand) {
                throw "PowerShell 7 or newer is required to register local Codex schedules"
            }
            $actionArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Run -DefinitionPath `"$($paths.Definition)`""
            $taskAction = New-ScheduledTaskAction -Execute $shellCommand.Source -Argument $actionArguments -WorkingDirectory $definition.workingDirectory
            $trigger = switch ($Frequency) {
                "Once" { New-ScheduledTaskTrigger -Once -At $At }
                "Daily" { New-ScheduledTaskTrigger -Daily -At $At }
                "Weekly" { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DaysOfWeek -At $At }
            }
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
            $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
            $targetKind = if ($NativeCodex) { "native Codex task" } else { "Codex task" }
            Register-ScheduledTask -TaskName $paths.TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description "Runs a local prompt in $targetKind $ThreadId" -Force | Out-Null
        }
    } catch {
        if ($null -eq $previous) {
            Remove-Item -LiteralPath $paths.Definition -Force -ErrorAction SilentlyContinue
        } else {
            $previous | Set-Content -LiteralPath $paths.Definition -Encoding UTF8
        }
        throw
    }
    Get-TaskState $definition | ConvertTo-Json -Depth 6 -Compress
}

function Get-Schedules {
    $jobsRoot = Join-Path $StateRoot "jobs"
    if (-not (Test-Path -LiteralPath $jobsRoot -PathType Container)) {
        "[]"
        return
    }
    $results = @(
        Get-ChildItem -LiteralPath $jobsRoot -Filter "*.json" -File | Sort-Object Name | ForEach-Object {
            Get-TaskState (Read-Definition $_.FullName)
        }
    )
    $results | ConvertTo-Json -Depth 6 -Compress
}

try {
    switch ($Action) {
        "Create" { New-Schedule }
        "List" { Get-Schedules }
        "Status" {
            $path = Resolve-DefinitionPath
            Get-TaskState (Read-Definition $path) | ConvertTo-Json -Depth 6 -Compress
        }
        "Run" {
            $path = Resolve-DefinitionPath
            Invoke-CodexSchedule $path
        }
        "RunNow" {
            $path = Resolve-DefinitionPath
            Invoke-CodexSchedule $path
        }
        "Remove" {
            $path = Resolve-DefinitionPath
            $definition = Read-Definition $path
            if (-not $DryRun) {
                Unregister-ScheduledTask -TaskName $definition.taskName -Confirm:$false -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $path -Force
            }
            [pscustomobject]@{
                removed = -not $DryRun
                dryRun = [bool]$DryRun
                name = $definition.name
                taskName = $definition.taskName
                logPath = $definition.logPath
            } | ConvertTo-Json -Compress
        }
    }
} catch {
    $errorDirectory = Join-Path $StateRoot "logs"
    New-Item -ItemType Directory -Path $errorDirectory -Force -ErrorAction SilentlyContinue | Out-Null
    [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        status = "bootstrap-failed"
        action = $Action
        definitionPath = $DefinitionPath
        message = $_.Exception.Message
        stack = $_.ScriptStackTrace
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $errorDirectory "scheduler-errors.jsonl") -Encoding UTF8 -ErrorAction SilentlyContinue
    throw
}
