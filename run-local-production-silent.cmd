@echo off
setlocal
cd /d "%~dp0"

if not exist "work\local-production" mkdir "work\local-production"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start-local-production-silent.ps1" %* >> "work\local-production\startup.log" 2>&1
exit /b %ERRORLEVEL%
