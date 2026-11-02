@echo off
rem Staff Mobile Key - install or upgrade on this server. Double-click it: Windows asks for administrator rights.
rem Options can be added after the name, for example:  Install.cmd -LanPort 9443
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -Include *.ps1,*.mjs,*.exe,*.dll | Unblock-File -ErrorAction SilentlyContinue; & '%~dp0install-onprem.ps1' %*; exit $LASTEXITCODE"
set RC=%errorlevel%
echo.
if not "%RC%"=="0" (echo The installation stopped with an error. See the message above.) else (echo Finished.)
pause
exit /b %RC%
