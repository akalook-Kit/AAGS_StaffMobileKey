@echo off
rem Access Monitoring Tool - remove it from this server. The data (database, settings, copies) is kept.
rem To delete the data too:  Uninstall.cmd -RemoveData
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)
copy /y "%~dp0uninstall-onprem.ps1" "%TEMP%\smk-uninstall.ps1" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\smk-uninstall.ps1" %*
set RC=%errorlevel%
del "%TEMP%\smk-uninstall.ps1" >nul 2>&1
echo.
pause
exit /b %RC%
