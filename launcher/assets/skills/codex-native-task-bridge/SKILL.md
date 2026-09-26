---
name: codex-native-task-bridge
description: Create, continue, inspect, and await native Codex tasks from a Codex turn backed by a ChatGPT Web model. Use automatically when the user asks the Web model to open or test another Codex task, run work in normal Codex, retrieve another task's result, or schedule work in native Codex; do not use for auxiliary ChatGPT browser conversations or ordinary subagents of the current task.
---

# Codex Native Task Bridge

Route cross-task work to the native Codex task system. A ChatGPT conversation URL, an Electron browser tab, and a Codex task id are different identities and must never be substituted for one another.

## Routing

1. When native task tools such as `create_thread`, `send_message_to_thread`, `read_thread`, or `wait_threads` are advertised by the current Codex harness, use them directly.
2. Discover deferred task tools once with `tool_search` before concluding that they are absent.
3. Create a task only when the user explicitly asks for a new task or when the requested isolation cannot be achieved in the current task.
4. After creating or continuing a task, wait for a terminal result and return its final human-facing message. A created id, `thread.started`, command exit, or partial commentary is not completion.
5. When native task tools are unavailable, invoke [scripts/manage-native-codex-task.ps1](scripts/manage-native-codex-task.ps1). `Create` uses the official Codex app-server protocol so the durable task is indexed and visible in the Desktop sidebar. `Resume` uses `codex exec resume --ignore-user-config` against that same task.

## Identity rules

- Accept only an exact Codex task UUID returned by a native task tool or a `thread.started` event.
- Never use a `chatgpt.com/c/...` id, retained ChatGPT conversation key, browser tab id, turn id, or MCP call id as a Codex task id.
- `$env:CODEX_THREAD_ID` identifies the current outer Codex task. It does not prove that the task uses a native model.
- When the user asks for normal or native Codex from a Web-backed task, create a native task instead of resuming the current Web-backed task.
- Reuse an existing native task when the user names it or when this skill created it for the same workflow. Do not create a replacement merely because a reconnect occurred.

## CLI fallback

Use PowerShell 7 and the bundled script:

```powershell
& "$PSScriptRoot\scripts\manage-native-codex-task.ps1" -Action Create -Prompt "Execute a validação e responda com o resultado." -WorkingDirectory "C:\projeto" -Sandbox read-only
```

```powershell
& "$PSScriptRoot\scripts\manage-native-codex-task.ps1" -Action Resume -ThreadId "TASK_UUID" -Prompt "Continue e entregue a conclusão."
```

```powershell
& "$PSScriptRoot\scripts\manage-native-codex-task.ps1" -Action Read -ThreadId "TASK_UUID"
```

The script returns JSON with `threadId`, `status`, `finalMessage`, `visibleInCodex`, and evidence paths. A `Create` result is complete only when `visibleInCodex` is true and the final message is present. Preserve the id for follow-up work.

## Scheduler integration

For scheduled native work, first resolve or create the native task through this skill. Then invoke `$codex-local-scheduler` with the returned task id and `-NativeCodex`. This makes Windows Task Scheduler resume the native Codex task with `--ignore-user-config` instead of opening another ChatGPT Web turn.

## Boundaries

- Do not use browser automation to create a Codex task.
- Do not accept a plain `codex exec` rollout as successful creation when the user asked for a visible Desktop task.
- Do not claim that a result came from native Codex unless the task metadata model does not start with `chatgpt-web/`.
- Do not use dangerous approval or sandbox bypass flags.
- Use `read-only` for tests unless repository changes are required. Use `workspace-write` only when the requested task must edit files.
- If tool discovery and the CLI fallback both fail, report the exact attempted command, task id if known, and log path. Ask one concise question about whether to retry in the current Web task or wait for native Codex availability.
