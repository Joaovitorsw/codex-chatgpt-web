[CmdletBinding()]
param(
    [ValidateSet("Create", "Resume", "Read", "List")]
    [string]$Action = "Create",
    [string]$ThreadId,
    [string]$ContextId = $env:CODEX_THREAD_ID,
    [string]$Prompt,
    [string]$WorkingDirectory,
    [ValidateSet("read-only", "workspace-write", "danger-full-access")]
    [string]$Sandbox = "read-only",
    [string]$Model,
    [ValidateSet("low", "medium", "high", "xhigh", "max", "ultra")]
    [string]$ReasoningEffort,
    [string]$CodexPath,
    [string[]]$CodexPrefixArguments = @(),
    [string]$CodexHome,
    [string]$StateRoot,
    [ValidateRange(1, 100)]
    [int]$Limit = 20,
    [ValidateRange(30, 3600)]
    [int]$TimeoutSeconds = 900,
    [switch]$ForceNew,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($userProfile)) {
    throw "User profile directory is unavailable"
}
if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Join-Path $userProfile ".codex"
}
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = Join-Path $CodexHome "native-task-bridge"
}
if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = (Get-Location).Path
}

function Resolve-CodexExecutable {
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

function Assert-NativeModel {
    param([string]$Value)
    if (-not [string]::IsNullOrWhiteSpace($Value) -and $Value.StartsWith("chatgpt-web/", [StringComparison]::OrdinalIgnoreCase)) {
        throw "A native Codex task cannot use a chatgpt-web model"
    }
}

function Assert-ThreadId {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -match '(?i)chatgpt\.com/c/' -or $Value -notmatch '^[0-9a-f]{8}-[0-9a-f-]{20,}$') {
        throw "ThreadId must be an exact native Codex task UUID, not a ChatGPT conversation id or URL"
    }
}

function Get-CodexThreadUrl {
    param([Parameter(Mandatory)][string]$Id)
    Assert-ThreadId $Id
    return "codex://threads/$Id"
}

function Get-ContextBindingPath {
    param([Parameter(Mandatory)][string]$Value)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    return Join-Path (Join-Path $StateRoot "contexts") "$hash.json"
}

function Read-ContextBinding {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }
    $path = Get-ContextBindingPath $Value
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    try {
        $binding = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ($binding.schemaVersion -ne 1 -or [string]$binding.contextId -ne $Value) {
            throw "Invalid context binding"
        }
        Assert-ThreadId ([string]$binding.threadId)
        $snapshot = Get-NativeTaskSnapshot ([string]$binding.threadId)
        if (-not $snapshot -or $snapshot.nativeCodex -ne $true -or $snapshot.source -eq "exec") {
            throw "Mapped native Codex task is unavailable"
        }
        return $binding
    } catch {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Save-ContextBinding {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)]$Result
    )
    $path = Get-ContextBindingPath $Value
    $directory = Split-Path -Parent $path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $binding = [pscustomobject]@{
        schemaVersion = 1
        contextId = $Value
        threadId = [string]$Result.threadId
        threadUrl = Get-CodexThreadUrl ([string]$Result.threadId)
        model = [string]$Result.model
        reasoningEffort = [string]$Result.reasoningEffort
        workingDirectory = $WorkingDirectory
        createdAt = (Get-Date).ToString("o")
        updatedAt = (Get-Date).ToString("o")
    }
    $temporary = "$path.$PID.tmp"
    $binding | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $path -Force
}

function Complete-ContextResult {
    param(
        [Parameter(Mandatory)][string]$Json,
        [Parameter(Mandatory)][bool]$Reused
    )
    $result = $Json | ConvertFrom-Json
    if (-not [string]::IsNullOrWhiteSpace([string]$result.threadId)) {
        $result | Add-Member -NotePropertyName threadUrl -NotePropertyValue (Get-CodexThreadUrl ([string]$result.threadId)) -Force
    }
    if (-not [string]::IsNullOrWhiteSpace($ContextId)) {
        $result | Add-Member -NotePropertyName contextId -NotePropertyValue $ContextId -Force
        $result | Add-Member -NotePropertyName reusedContext -NotePropertyValue $Reused -Force
    }
    if (-not $DryRun -and -not [string]::IsNullOrWhiteSpace([string]$result.receiptPath) -and (Test-Path -LiteralPath $result.receiptPath -PathType Leaf)) {
        $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $result.receiptPath -Encoding UTF8
    }
    $result | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-NativeProcess {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Directory
    )
    if ($PSVersionTable.PSEdition -ne "Core") {
        throw "PowerShell 7 or newer is required"
    }
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $Directory
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    $startInfo.Environment["CODEX_HOME"] = $CodexHome
    [void]$startInfo.Environment.Remove("OPENAI_BASE_URL")
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
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.GetAwaiter().GetResult().TrimEnd()
        Stderr = $stderrTask.GetAwaiter().GetResult().TrimEnd()
    }
}

function Get-RunPaths {
    $runRoot = Join-Path $StateRoot "runs"
    New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
    $name = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
    return [pscustomobject]@{
        EventLog = Join-Path $runRoot "$name.jsonl"
        ErrorLog = Join-Path $runRoot "$name.stderr.log"
        LastMessage = Join-Path $runRoot "$name.final.txt"
        Receipt = Join-Path $runRoot "$name.receipt.json"
    }
}

function ConvertFrom-CodexEvents {
    param([string]$Text)
    $events = New-Object System.Collections.Generic.List[object]
    foreach ($line in ($Text -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            $events.Add(($line | ConvertFrom-Json))
        } catch {
        }
    }
    return $events.ToArray()
}

function Start-AppServerProcess {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Directory
    )
    if ($PSVersionTable.PSEdition -ne "Core") {
        throw "PowerShell 7 or newer is required"
    }
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $Directory
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardInputEncoding = $utf8
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    $startInfo.CreateNoWindow = $true
    $startInfo.Environment["CODEX_HOME"] = $CodexHome
    $startInfo.Environment["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"] = "Codex Desktop"
    [void]$startInfo.Environment.Remove("OPENAI_BASE_URL")
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start the Codex app-server"
    }
    return [pscustomobject]@{
        Process = $process
        ErrorTask = $process.StandardError.ReadToEndAsync()
        PendingRead = $null
        RawLines = New-Object System.Collections.Generic.List[string]
    }
}

function Send-AppServerMessage {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Message
    )
    $line = $Message | ConvertTo-Json -Compress -Depth 40
    $State.Process.StandardInput.WriteLine($line)
    $State.Process.StandardInput.Flush()
}

function Read-AppServerMessage {
    param(
        [Parameter(Mandatory)]$State,
        [ValidateRange(1, 3600)][int]$WaitSeconds
    )
    if ($null -eq $State.PendingRead) {
        $State.PendingRead = $State.Process.StandardOutput.ReadLineAsync()
    }
    if (-not $State.PendingRead.Wait($WaitSeconds * 1000)) {
        throw "Codex app-server stopped responding after $WaitSeconds seconds"
    }
    $line = $State.PendingRead.Result
    $State.PendingRead = $null
    if ($null -eq $line) {
        throw "Codex app-server closed before completing the task"
    }
    [void]$State.RawLines.Add($line)
    try {
        return $line | ConvertFrom-Json
    } catch {
        return Read-AppServerMessage -State $State -WaitSeconds $WaitSeconds
    }
}

function Read-AppServerResponse {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)][int]$Id,
        [ValidateRange(1, 3600)][int]$WaitSeconds
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
        $message = Read-AppServerMessage -State $State -WaitSeconds ([Math]::Min(30, $remaining))
        if ($message.id -eq $Id) {
            return $message
        }
        if ($null -ne $message.id -and -not [string]::IsNullOrWhiteSpace([string]$message.method)) {
            throw "Native Codex task requires an interactive response: $($message.method)"
        }
    }
    throw "Timed out waiting for Codex app-server response $Id"
}

function Stop-AppServerProcess {
    param([Parameter(Mandatory)]$State)
    try {
        $State.Process.StandardInput.Close()
    } catch {
    }
    if (-not $State.Process.HasExited -and -not $State.Process.WaitForExit(3000)) {
        try {
            $State.Process.Kill($true)
        } catch {
        }
    }
    try {
        return $State.ErrorTask.GetAwaiter().GetResult().TrimEnd()
    } catch {
        return ""
    }
}

function Select-NativeModel {
    param(
        [Parameter(Mandatory)]$ModelResponse,
        [string]$RequestedModel
    )
    $models = @(
        $ModelResponse.result.data | Where-Object {
            $_.hidden -ne $true -and
            -not [string]::IsNullOrWhiteSpace([string]$_.model) -and
            -not ([string]$_.model).StartsWith("chatgpt-web/", [StringComparison]::OrdinalIgnoreCase)
        }
    )
    if ($models.Count -eq 0) {
        throw "Codex app-server did not expose a native model"
    }
    if (-not [string]::IsNullOrWhiteSpace($RequestedModel)) {
        $selected = $models | Where-Object {
            [string]$_.model -eq $RequestedModel -or [string]$_.id -eq $RequestedModel
        } | Select-Object -First 1
        if (-not $selected -and $RequestedModel.Equals("instant", [StringComparison]::OrdinalIgnoreCase)) {
            $selected = $models | Where-Object {
                [string]$_.model -match '(?i)sol|instant' -or
                [string]$_.id -match '(?i)sol|instant' -or
                [string]$_.displayName -match '(?i)sol|instant'
            } | Select-Object -First 1
        }
        if (-not $selected) {
            throw "Native Codex model is unavailable: $RequestedModel"
        }
        return $selected
    }
    $default = $models | Where-Object { $_.isDefault -eq $true } | Select-Object -First 1
    return $default ?? $models[0]
}

function Invoke-VisibleNativeTask {
    param(
        [Parameter(Mandatory)][string]$ResolvedCodex,
        [Parameter(Mandatory)][string]$ResolvedWorkingDirectory
    )
    $paths = Get-RunPaths
    $arguments = @($CodexPrefixArguments) + @(
        "app-server",
        "--stdio",
        "-c", 'openai_base_url=""'
    )
    if ($DryRun) {
        [pscustomobject]@{
            dryRun = $true
            action = "Create"
            transport = "app-server"
            nativeCodex = $true
            visibleInCodex = $true
            threadUrl = $null
            executable = $ResolvedCodex
            arguments = $arguments
            eventLog = $paths.EventLog
            lastMessagePath = $paths.LastMessage
        } | ConvertTo-Json -Depth 8 -Compress
        return
    }
    $state = $null
    $receipt = $null
    $failure = $null
    $stderr = ""
    try {
        $state = Start-AppServerProcess -Executable $ResolvedCodex -Arguments $arguments -Directory $ResolvedWorkingDirectory
        Send-AppServerMessage -State $state -Message @{
            id = 1
            method = "initialize"
            params = @{
                clientInfo = @{ name = "codex-native-task-bridge"; version = "1.1.0" }
                capabilities = @{ experimentalApi = $true }
            }
        }
        $initialized = Read-AppServerResponse -State $state -Id 1 -WaitSeconds 30
        if ($initialized.error) {
            throw [string]$initialized.error.message
        }
        Send-AppServerMessage -State $state -Message @{ method = "initialized"; params = @{} }
        Send-AppServerMessage -State $state -Message @{
            id = 2
            method = "model/list"
            params = @{ limit = 100; includeHidden = $false }
        }
        $modelResponse = Read-AppServerResponse -State $state -Id 2 -WaitSeconds 60
        if ($modelResponse.error) {
            throw [string]$modelResponse.error.message
        }
        $selectedModel = Select-NativeModel -ModelResponse $modelResponse -RequestedModel $Model
        $selectedEffort = if (-not [string]::IsNullOrWhiteSpace($ReasoningEffort)) {
            $ReasoningEffort
        } else {
            [string]$selectedModel.defaultReasoningEffort
        }
        $supportedEfforts = @(
            $selectedModel.supportedReasoningEfforts | ForEach-Object {
                if ($_ -is [string]) {
                    [string]$_
                } elseif (-not [string]::IsNullOrWhiteSpace([string]$_.reasoningEffort)) {
                    [string]$_.reasoningEffort
                } else {
                    [string]$_.effort
                }
            }
        )
        if (-not [string]::IsNullOrWhiteSpace($selectedEffort) -and
            $supportedEfforts.Count -gt 0 -and $supportedEfforts -notcontains $selectedEffort) {
            throw "$($selectedModel.displayName) does not support effort $selectedEffort"
        }
        Send-AppServerMessage -State $state -Message @{
            id = 3
            method = "thread/start"
            params = @{
                cwd = $ResolvedWorkingDirectory
                runtimeWorkspaceRoots = @($ResolvedWorkingDirectory)
                model = [string]$selectedModel.model
                modelProvider = "openai"
                sandbox = $Sandbox
                approvalPolicy = "never"
                approvalsReviewer = "user"
                ephemeral = $false
                historyMode = "paginated"
                threadSource = "user"
                sessionStartSource = "startup"
            }
        }
        $threadResponse = Read-AppServerResponse -State $state -Id 3 -WaitSeconds 60
        if ($threadResponse.error) {
            throw [string]$threadResponse.error.message
        }
        $createdThread = $threadResponse.result.thread
        $resolvedThreadId = [string]$createdThread.id
        Assert-ThreadId $resolvedThreadId
        $turnParams = @{
            threadId = $resolvedThreadId
            input = @(@{ type = "text"; text = $Prompt; text_elements = @() })
            model = [string]$selectedModel.model
        }
        if (-not [string]::IsNullOrWhiteSpace($selectedEffort)) {
            $turnParams.effort = $selectedEffort
        }
        Send-AppServerMessage -State $state -Message @{ id = 4; method = "turn/start"; params = $turnParams }
        $turnResponse = Read-AppServerResponse -State $state -Id 4 -WaitSeconds 60
        if ($turnResponse.error) {
            throw [string]$turnResponse.error.message
        }
        $turnId = [string]$turnResponse.result.turn.id
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $completed = $null
        while ([DateTime]::UtcNow -lt $deadline) {
            $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
            $message = Read-AppServerMessage -State $state -WaitSeconds ([Math]::Min(30, $remaining))
            if ($null -ne $message.id -and -not [string]::IsNullOrWhiteSpace([string]$message.method)) {
                throw "Native Codex task requires an interactive response: $($message.method)"
            }
            if ($message.method -eq "turn/completed" -and
                [string]$message.params.threadId -eq $resolvedThreadId -and
                [string]$message.params.turn.id -eq $turnId) {
                $completed = $message.params.turn
                break
            }
        }
        if (-not $completed) {
            throw "Native Codex task did not complete within $TimeoutSeconds seconds"
        }
        Send-AppServerMessage -State $state -Message @{
            id = 5
            method = "thread/read"
            params = @{ threadId = $resolvedThreadId; includeTurns = $true }
        }
        $readResponse = Read-AppServerResponse -State $state -Id 5 -WaitSeconds 60
        if ($readResponse.error) {
            throw [string]$readResponse.error.message
        }
        $thread = $readResponse.result.thread
        $turns = @($thread.turns)
        $finalMessage = ""
        if ($turns.Count -gt 0) {
            $targetTurn = $turns | Where-Object { [string]$_.id -eq $turnId } | Select-Object -Last 1
            if (-not $targetTurn) {
                $targetTurn = $turns[-1]
            }
            $agentMessages = @($targetTurn.items | Where-Object { $_.type -eq "agentMessage" })
            if ($agentMessages.Count -gt 0) {
                $finalMessage = [string]$agentMessages[-1].text
            }
        }
        if ([string]::IsNullOrWhiteSpace($finalMessage)) {
            throw "Native Codex completed without a final human-facing message"
        }
        if ([string]$completed.status -ne "completed") {
            $detail = if ($completed.error) { [string]$completed.error.message } else { [string]$completed.status }
            throw "Native Codex task failed: $detail"
        }
        $source = [string]$thread.source
        if ($source -eq "exec") {
            throw "Native Codex created a non-interactive task that may be hidden from the sidebar"
        }
        $receipt = [pscustomobject]@{
            action = "Create"
            transport = "app-server"
            nativeCodex = $true
            visibleInCodex = $true
            source = $source
            originator = [string]$thread.originator
            model = [string]$threadResponse.result.model
            modelProvider = [string]$threadResponse.result.modelProvider
            reasoningEffort = $selectedEffort
            threadId = $resolvedThreadId
            threadUrl = Get-CodexThreadUrl $resolvedThreadId
            turnId = $turnId
            status = "completed"
            exitCode = 0
            finalMessage = $finalMessage
            turnCompleted = $true
            error = $null
            eventLog = $paths.EventLog
            errorLog = $paths.ErrorLog
            lastMessagePath = $paths.LastMessage
            receiptPath = $paths.Receipt
            rolloutPath = [string]$thread.path
        }
    } catch {
        $failure = $_
    } finally {
        if ($state) {
            $stderr = Stop-AppServerProcess -State $state
            $state.RawLines.ToArray() | Set-Content -LiteralPath $paths.EventLog -Encoding UTF8
        }
        $stderr | Set-Content -LiteralPath $paths.ErrorLog -Encoding UTF8
    }
    if ($failure) {
        throw "$($failure.Exception.Message). See $($paths.EventLog) and $($paths.ErrorLog)"
    }
    $receipt.finalMessage | Set-Content -LiteralPath $paths.LastMessage -Encoding UTF8
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $paths.Receipt -Encoding UTF8
    $receipt | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-TaskTurn {
    param(
        [ValidateSet("Create", "Resume")][string]$Mode,
        [string]$RequestedThreadId = $ThreadId,
        [string]$RequestedModel = $Model,
        [string]$RequestedReasoningEffort = $ReasoningEffort
    )
    if ([string]::IsNullOrWhiteSpace($Prompt)) {
        throw "Prompt is required"
    }
    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
        throw "Working directory was not found: $WorkingDirectory"
    }
    if ($Mode -eq "Resume") {
        if ([string]::IsNullOrWhiteSpace($RequestedThreadId)) {
            throw "ThreadId is required for Resume"
        }
        Assert-ThreadId $RequestedThreadId
    }
    $effectiveModel = $RequestedModel
    $effectiveReasoningEffort = $RequestedReasoningEffort
    if ($Mode -eq "Resume" -and
        ([string]::IsNullOrWhiteSpace($effectiveModel) -or [string]::IsNullOrWhiteSpace($effectiveReasoningEffort))) {
        $configuration = Get-NativeTaskSnapshot $RequestedThreadId
        if ($configuration) {
            if ([string]::IsNullOrWhiteSpace($effectiveModel)) {
                $effectiveModel = [string]$configuration.model
            }
            if ([string]::IsNullOrWhiteSpace($effectiveReasoningEffort)) {
                $effectiveReasoningEffort = [string]$configuration.reasoningEffort
            }
        }
    }
    Assert-NativeModel $effectiveModel
    $resolvedCodex = Resolve-CodexExecutable $CodexPath
    $resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
    if ($Mode -eq "Create") {
        Invoke-VisibleNativeTask -ResolvedCodex $resolvedCodex -ResolvedWorkingDirectory $resolvedWorkingDirectory
        return
    }
    $paths = Get-RunPaths
    $arguments = @($CodexPrefixArguments)
    $arguments += @(
        "exec",
        "resume",
        "--ignore-user-config",
        "--json",
        "-o", $paths.LastMessage
    )
    if (-not [string]::IsNullOrWhiteSpace($effectiveModel)) {
        $arguments += @("-m", $effectiveModel)
    }
    if (-not [string]::IsNullOrWhiteSpace($effectiveReasoningEffort)) {
        $arguments += @("-c", "model_reasoning_effort=`"$effectiveReasoningEffort`"")
    }
    $arguments += $RequestedThreadId
    $arguments += $Prompt
    if ($DryRun) {
        [pscustomobject]@{
            dryRun = $true
            action = $Mode
            transport = "exec-resume"
            nativeCodex = $true
            threadId = $RequestedThreadId
            threadUrl = Get-CodexThreadUrl $RequestedThreadId
            model = $effectiveModel
            reasoningEffort = $effectiveReasoningEffort
            executable = $resolvedCodex
            arguments = $arguments
            eventLog = $paths.EventLog
            lastMessagePath = $paths.LastMessage
        } | ConvertTo-Json -Depth 8 -Compress
        return
    }
    $result = Invoke-NativeProcess -Executable $resolvedCodex -Arguments $arguments -Directory $resolvedWorkingDirectory
    $result.Stdout | Set-Content -LiteralPath $paths.EventLog -Encoding UTF8
    $result.Stderr | Set-Content -LiteralPath $paths.ErrorLog -Encoding UTF8
    $events = @(ConvertFrom-CodexEvents $result.Stdout)
    $started = $events | Where-Object { $_.type -eq "thread.started" } | Select-Object -Last 1
    $resolvedThreadId = if ($started -and -not [string]::IsNullOrWhiteSpace([string]$started.thread_id)) {
        [string]$started.thread_id
    } else {
        $RequestedThreadId
    }
    if (-not [string]::IsNullOrWhiteSpace($resolvedThreadId)) {
        Assert-ThreadId $resolvedThreadId
    }
    $snapshot = if (-not [string]::IsNullOrWhiteSpace($resolvedThreadId)) {
        Get-NativeTaskSnapshot $resolvedThreadId
    } else {
        $null
    }
    $turnCompleted = [bool]($events | Where-Object { $_.type -eq "turn.completed" } | Select-Object -Last 1)
    $turnFailed = $events | Where-Object { $_.type -eq "turn.failed" } | Select-Object -Last 1
    $agentMessages = @(
        $events | Where-Object {
            $_.type -eq "item.completed" -and $_.item -and $_.item.type -eq "agent_message"
        } | ForEach-Object { [string]$_.item.text } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    $finalMessage = if (Test-Path -LiteralPath $paths.LastMessage -PathType Leaf) {
        (Get-Content -LiteralPath $paths.LastMessage -Raw).Trim()
    } elseif ($agentMessages.Count -gt 0) {
        $agentMessages[-1]
    } else {
        ""
    }
    $nativeVerified = $snapshot -and $snapshot.nativeCodex -eq $true
    $status = if ($result.ExitCode -eq 0 -and $turnCompleted -and $nativeVerified) { "completed" } else { "failed" }
    $receipt = [pscustomobject]@{
        action = $Mode
        transport = "exec-resume"
        nativeCodex = [bool]$nativeVerified
        visibleInCodex = [bool]($snapshot -and $snapshot.source -ne "exec")
        model = if ($snapshot) { $snapshot.model } else { "" }
        modelProvider = if ($snapshot) { $snapshot.modelProvider } else { "" }
        reasoningEffort = if ($snapshot) { $snapshot.reasoningEffort } else { $effectiveReasoningEffort }
        threadId = $resolvedThreadId
        threadUrl = Get-CodexThreadUrl $resolvedThreadId
        status = $status
        exitCode = $result.ExitCode
        finalMessage = $finalMessage
        turnCompleted = $turnCompleted
        error = if ($turnFailed -and $turnFailed.error) { [string]$turnFailed.error.message } else { $null }
        eventLog = $paths.EventLog
        errorLog = $paths.ErrorLog
        lastMessagePath = $paths.LastMessage
        receiptPath = $paths.Receipt
        rolloutPath = if ($snapshot) { $snapshot.rolloutPath } else { $null }
    }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $paths.Receipt -Encoding UTF8
    $receipt | ConvertTo-Json -Depth 8 -Compress
    if ($status -ne "completed") {
        throw "Native Codex task did not complete. See $($paths.Receipt)"
    }
}

function Find-Rollout {
    param([Parameter(Mandatory)][string]$Id)
    Assert-ThreadId $Id
    $sessions = Join-Path $CodexHome "sessions"
    if (-not (Test-Path -LiteralPath $sessions -PathType Container)) {
        return $null
    }
    return Get-ChildItem -LiteralPath $sessions -Recurse -File -Filter "*$Id*.jsonl" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function Get-NativeTaskSnapshot {
    param([Parameter(Mandatory)][string]$Id)
    $rollout = Find-Rollout $Id
    if (-not $rollout) {
        return $null
    }
    $metadata = $null
    $model = ""
    $reasoningEffort = ""
    $latestUser = ""
    $latestAssistant = ""
    $status = "unknown"
    foreach ($line in Get-Content -LiteralPath $rollout.FullName) {
        try {
            $entry = $line | ConvertFrom-Json
        } catch {
            continue
        }
        if ($entry.type -eq "session_meta") {
            $metadata = $entry.payload
        }
        if ($entry.type -eq "turn_context") {
            if (-not [string]::IsNullOrWhiteSpace([string]$entry.payload.model)) {
                $model = [string]$entry.payload.model
            } elseif ($entry.payload.collaboration_mode -and $entry.payload.collaboration_mode.settings) {
                $model = [string]$entry.payload.collaboration_mode.settings.model
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$entry.payload.effort)) {
                $reasoningEffort = [string]$entry.payload.effort
            } elseif (-not [string]::IsNullOrWhiteSpace([string]$entry.payload.reasoning_effort)) {
                $reasoningEffort = [string]$entry.payload.reasoning_effort
            } elseif ($entry.payload.collaboration_mode -and $entry.payload.collaboration_mode.settings -and
                -not [string]::IsNullOrWhiteSpace([string]$entry.payload.collaboration_mode.settings.reasoning_effort)) {
                $reasoningEffort = [string]$entry.payload.collaboration_mode.settings.reasoning_effort
            }
            $status = "active-or-incomplete"
        }
        if ($entry.type -eq "response_item" -and $entry.payload.type -eq "message") {
            $text = @($entry.payload.content | ForEach-Object { [string]$_.text }) -join "`n"
            if ($entry.payload.role -eq "user") {
                $latestUser = $text
            } elseif ($entry.payload.role -eq "assistant") {
                $latestAssistant = $text
            }
        }
        if ($entry.type -eq "event_msg" -and $entry.payload.type -eq "task_complete") {
            $status = "completed"
            if (-not [string]::IsNullOrWhiteSpace([string]$entry.payload.last_agent_message)) {
                $latestAssistant = [string]$entry.payload.last_agent_message
            }
        }
    }
    $modelProvider = if ($metadata) { [string]$metadata.model_provider } else { "" }
    return [pscustomobject]@{
        nativeCodex = -not [string]::IsNullOrWhiteSpace($model) -and
            -not $model.StartsWith("chatgpt-web/", [StringComparison]::OrdinalIgnoreCase)
        threadId = $Id
        threadUrl = Get-CodexThreadUrl $Id
        status = $status
        model = $model
        reasoningEffort = $reasoningEffort
        modelProvider = $modelProvider
        cwd = if ($metadata) { [string]$metadata.cwd } else { "" }
        source = if ($metadata) { [string]$metadata.source } else { "" }
        latestUserMessage = $latestUser
        finalMessage = $latestAssistant
        rolloutPath = $rollout.FullName
        updatedAt = $rollout.LastWriteTime.ToString("o")
    }
}

function Read-NativeTask {
    if ([string]::IsNullOrWhiteSpace($ThreadId)) {
        throw "ThreadId is required for Read"
    }
    $snapshot = Get-NativeTaskSnapshot $ThreadId
    if (-not $snapshot) {
        throw "Native Codex task rollout was not found: $ThreadId"
    }
    $snapshot | ConvertTo-Json -Depth 8 -Compress
}

function Get-NativeTasks {
    $sessions = Join-Path $CodexHome "sessions"
    if (-not (Test-Path -LiteralPath $sessions -PathType Container)) {
        "[]"
        return
    }
    $results = @(
        Get-ChildItem -LiteralPath $sessions -Recurse -File -Filter "rollout-*.jsonl" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First $Limit |
            ForEach-Object {
                if ($_.BaseName -match '([0-9a-f]{8}-[0-9a-f-]{20,})$') {
                    Get-NativeTaskSnapshot $Matches[1]
                }
            }
    )
    $results | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-ContextAwareCreate {
    if (-not $ForceNew -and -not [string]::IsNullOrWhiteSpace($ContextId)) {
        $binding = Read-ContextBinding $ContextId
        if ($binding) {
            $json = Invoke-TaskTurn -Mode "Resume" `
                -RequestedThreadId ([string]$binding.threadId) `
                -RequestedModel ([string]$binding.model) `
                -RequestedReasoningEffort ([string]$binding.reasoningEffort)
            Complete-ContextResult -Json $json -Reused $true
            return
        }
    }
    $json = Invoke-TaskTurn "Create"
    if (-not $DryRun -and -not [string]::IsNullOrWhiteSpace($ContextId)) {
        $created = $json | ConvertFrom-Json
        Save-ContextBinding -Value $ContextId -Result $created
    }
    Complete-ContextResult -Json $json -Reused $false
}

switch ($Action) {
    "Create" { Invoke-ContextAwareCreate }
    "Resume" { Invoke-TaskTurn "Resume" }
    "Read" { Read-NativeTask }
    "List" { Get-NativeTasks }
}
