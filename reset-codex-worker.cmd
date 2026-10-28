@echo off
setlocal
title Codex Web GPT - Reset Codex Worker
rem Restarts Codex Desktop, the local launcher/bridge and native DevSpace after active Web turns finish.
rem Keeps the OpenCodex web service running.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\restart-local-production-safe.ps1" %* -PreserveOpenCodex
exit /b %ERRORLEVEL%
