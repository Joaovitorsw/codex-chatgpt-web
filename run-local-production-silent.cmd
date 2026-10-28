@echo off
setlocal
rem Starts the local production launcher, DevSpace and OpenCodex web at http://127.0.0.1:3737.
cd /d "%~dp0"

if not exist "work\local-production" mkdir "work\local-production"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start-local-production-silent.ps1" %* >> "work\local-production\startup.log" 2>&1
exit /b %ERRORLEVEL%
