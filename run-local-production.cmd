@echo off
setlocal
title Codex Web GPT - Local Production
cd /d "%~dp0"
set "CODEX_WEB_GPT_LOCAL_PRODUCTION=1"

rem Keep an explicitly supplied runtime, otherwise discover the installed Bun.
if defined CODEX_WEB_GPT_BUN if exist "%CODEX_WEB_GPT_BUN%" goto bun_ready
set "CODEX_WEB_GPT_BUN="
for %%B in (
  "%ProgramFiles%\Codex Web GPT\resources\runtime\runtime\bun.exe"
  "%LOCALAPPDATA%\Programs\Codex Web GPT\resources\runtime\runtime\bun.exe"
  "%LOCALAPPDATA%\Codex Web GPT\resources\runtime\runtime\bun.exe"
  "%USERPROFILE%\.bun\bin\bun.exe"
) do if not defined CODEX_WEB_GPT_BUN if exist "%%~fB" set "CODEX_WEB_GPT_BUN=%%~fB"
if not defined CODEX_WEB_GPT_BUN for /f "delims=" %%B in ('where bun.exe 2^>nul') do if not defined CODEX_WEB_GPT_BUN set "CODEX_WEB_GPT_BUN=%%~fB"
if not defined CODEX_WEB_GPT_BUN for /d %%V in ("%USERPROFILE%\.codex-chatgpt-web\versions\*") do if exist "%%~fV\runtime\bun.exe" set "CODEX_WEB_GPT_BUN=%%~fV\runtime\bun.exe"

if not defined CODEX_WEB_GPT_BUN (
  echo [ERRO] Nao foi possivel localizar o runtime Bun do Codex Web GPT.
  echo.
  echo Instale o Codex Web GPT ou defina CODEX_WEB_GPT_BUN com o caminho do bun.exe.
  echo A janela permanecera aberta para que este erro possa ser copiado.
  echo.
  pause
  exit /b 1
)

:bun_ready
echo Runtime: "%CODEX_WEB_GPT_BUN%"
if not exist "package.json" (
  echo [ERRO] package.json nao foi encontrado em "%CD%".
  echo Execute este arquivo dentro da pasta raiz do codigo-fonte.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Dependencias locais ausentes. Instalando com Bun...
  "%CODEX_WEB_GPT_BUN%" install
  if errorlevel 1 (
    echo.
    echo [ERRO] A instalacao das dependencias falhou.
    echo Verifique a conexao, proxy ou antivirus e copie a mensagem acima.
    pause
    exit /b 1
  )
)
echo Starting Codex Web GPT from local source with the production profile...
"%CODEX_WEB_GPT_BUN%" run launcher:dev
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Launcher exited with code %EXIT_CODE%.
echo The local launcher stopped. Press any key to close this terminal.
pause >nul
exit /b %EXIT_CODE%
