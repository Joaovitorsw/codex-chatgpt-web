@echo off
setlocal
title Codex Web GPT - Safe Restart Queue
rem Restarts Codex Desktop, launcher/bridge, native DevSpace and OpenCodex.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\restart-local-production-safe.ps1" %*
if errorlevel 1 (
  echo Safe restart could not be queued.
  pause
  exit /b 1
)
echo The restart was queued and will apply after active turns finish.
timeout /t 3 /nobreak >nul
exit /b 0
