---
name: codex-local-scheduler
description: Schedule a prompt to run later or repeatedly in an existing Codex task on this Windows PC. Use when the user asks for a local Codex schedule, recurring Codex work, or a prompt to be queued into the current task at a future time; do not use for cloud OpenAI automations or ordinary reminders that should not run Codex.
---

# Codex Local Scheduler

Schedule prompts through Windows Task Scheduler and `codex exec resume`. Existing tasks are the default so scheduled work resumes the same Codex context instead of creating a new chat. Definitions and logs are stored under `%USERPROFILE%\.codex\local-scheduler`, which is shared by the Codex app, CLI, and Windows Task Scheduler.

## Workflow

1. Resolve the target task:
   - Prefer `$env:CODEX_THREAD_ID` for the current Codex task.
   - Accept an exact task UUID or exact task name supplied by the user.
   - Create a new task only when the user explicitly requests one. Capture its thread id from the `thread.started` event emitted by `codex exec --json`.
   - When this skill is invoked from a Web-backed task and the user wants normal or native Codex, use `$codex-native-task-bridge` first. Schedule the returned UUID with `-NativeCodex`; do not schedule a ChatGPT conversation id or create another Electron browser tab.
2. Resolve the requested local date and time in the machine timezone. State the absolute date and recurrence when relative wording could be confusing.
3. Choose a short stable schedule name and invoke [scripts/manage-codex-schedule.ps1](scripts/manage-codex-schedule.ps1):
   - `Create` registers a one-time, daily, or weekly task.
   - `List` and `Status` inspect schedules.
   - `RunNow` executes the saved definition immediately.
   - `Remove` unregisters a schedule only after the user explicitly asks to remove it.
   - `Resume` is the default execution mode and wakes a dormant task to run the prompt.
   - `Queue` is available only when the user explicitly wants to append a message to an already active task.
4. Verify the saved definition and Windows task with `Status` after creation.
5. Report the target Codex task, next run, recurrence, state file, and log file.

## Defaults and boundaries

- Use the current task id automatically when it exists.
- The current task id does not prove that its model is native. Use `-NativeCodex` only for a task created or verified by `$codex-native-task-bridge`.
- Resume mode preserves the target task's existing sandbox and workspace. Use a task created with the required write access when the scheduled instruction must edit files.
- Native Codex schedules add `--ignore-user-config`, so the saved global Web GPT route cannot convert the scheduled execution back into a Web model.
- Queue mode uses `read-only` sandbox unless the scheduled instruction explicitly requires repository edits.
- When overriding the model, also pass its compatible reasoning effort with `-ReasoningEffort` so a saved Pro effort is not inherited by an Instant or Sol task.
- Never use the dangerous approval or sandbox bypass flags.
- Do not place credentials, tokens, passwords, or other secrets in a scheduled prompt. Prompt text is stored locally on disk.
- Keep retries bounded. Resume mode retries only failures that happen before a turn starts, preventing duplicate side effects after Codex begins work.
- One-time Windows tasks unregister themselves after a successful queue while retaining their definition and execution log for inspection.

## Examples

```powershell
& "$PSScriptRoot\scripts\manage-codex-schedule.ps1" -Action Create -Name "revisao-noturna" -Message "Revise as alterações de hoje e resuma os riscos." -DelayMinutes 30
```

```powershell
& "$PSScriptRoot\scripts\manage-codex-schedule.ps1" -Action Create -Name "status-diario" -ThreadId $env:CODEX_THREAD_ID -Message "Faça o resumo diário deste projeto." -At "2026-09-27 09:00" -Frequency Daily
```

```powershell
& "$PSScriptRoot\scripts\manage-codex-schedule.ps1" -Action Create -Name "teste-nativo" -NativeCodex -ThreadId "TASK_UUID" -Message "Execute a validação no Codex nativo." -DelayMinutes 10
```

```powershell
& "$PSScriptRoot\scripts\manage-codex-schedule.ps1" -Action RunNow -Name "revisao-noturna"
```

```powershell
& "$PSScriptRoot\scripts\manage-codex-schedule.ps1" -Action Create -Name "fila-chat-ativo" -Mode Queue -ThreadId $env:CODEX_THREAD_ID -Message "Execute esta instrução depois do turno atual." -DelayMinutes 10
```
