@echo off
rem Access Monitoring Tool - show the one-time code of the first-run setup page (Start menu: "Access Monitoring Tool - setup code").
rem The code file is readable by administrators only, so Windows asks for administrator permission first.
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WindowStyle Hidden"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0show-setup-code.ps1"
