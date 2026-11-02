@echo off
rem Staff Mobile Key - open the portal on this server. Before the hotel is set up, it opens the first-run setup page
rem with the setup code filled in (reading the code needs administrator rights, so Windows may ask).
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WindowStyle Hidden"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0open-portal.ps1"
