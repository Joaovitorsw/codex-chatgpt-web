@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1

echo Recuperando o Native2 e ativando a supervisao automatica...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-production-silent.ps1" -DevSpaceOnly
set "RECOVERY_RESULT=%ERRORLEVEL%"
if not "%RECOVERY_RESULT%"=="0" (
  echo.
  echo Falha na recuperacao. Consulte work\devspace\startup.log
  if /i not "%~1"=="--no-pause" pause
  exit /b %RECOVERY_RESULT%
)
echo.
echo Native2 recuperado. Supervisao automatica ativada.
echo Logs: work\devspace\startup.log e work\devspace\watchdog.log
if /i not "%~1"=="--no-pause" pause
exit /b 0
