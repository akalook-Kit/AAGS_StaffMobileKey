@echo off
rem Access Monitoring Tool - trust Visionline's certificate again (after it was renewed), or accept this exact
rem certificate although it has expired (Start menu: "Access Monitoring Tool - Visionline certificate").
rem Needs administrator rights: Windows asks first.
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  if "%~1"=="" (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs") else (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs")
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0trust-visionline-certificate.ps1" %*
echo.
pause
