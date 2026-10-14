<#
  Starts the staff app dev server so Expo Go on your phone can open it.
  Needs Node.js 22 on this PC and the environment started with:  .\scripts\windows\start.ps1 -Phone
    .\scripts\windows\phone.ps1                     # auto-detect this PC's Wi-Fi address
    .\scripts\windows\phone.ps1 -Ip 192.168.1.20    # or give it
    .\scripts\windows\phone.ps1 -AddFirewallRule    # once, from an Administrator PowerShell
#>
param([string]$Ip, [switch]$AddFirewallRule, [switch]$RemoveFirewallRule)
$ErrorActionPreference = 'Continue'  # native tools (docker) write progress to stderr; we check exit codes instead
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
Initialize-SmkEnv
$cfg = Read-SmkEnv
$ruleName = "$($cfg.COMPOSE_PROJECT_NAME) phone testing"

if ($AddFirewallRule -or $RemoveFirewallRule) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { Write-Host "Run this in PowerShell opened with 'Run as administrator'." -ForegroundColor Red; exit 1 }
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($AddFirewallRule) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -Action Allow -Profile Private `
      -LocalPort @([int]$cfg.SMK_PORTAL_PORT, [int]$cfg.SMK_SIM_PORT, [int]$cfg.SMK_EXPO_PORT) | Out-Null
    Write-Host "Firewall rule '$ruleName' added (private networks only)." -ForegroundColor Green
  } else { Write-Host "Firewall rule removed." -ForegroundColor Green }
  exit 0
}

if ($cfg.SMK_BIND -ne '0.0.0.0') { Write-Host "Restart with phone access first:  .\scripts\windows\start.ps1 -Phone" -ForegroundColor Red; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Install Node.js 22 LTS from https://nodejs.org first." -ForegroundColor Red; exit 1 }

if (-not $Ip) {
  $Ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback|VirtualBox|VMware' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Sort-Object -Property @{ Expression = { if ($_.InterfaceAlias -match 'Wi-?Fi|Wireless') { 0 } else { 1 } } } |
    Select-Object -First 1).IPAddress
}
if (-not $Ip) { Write-Host "Could not detect your Wi-Fi address. Run ipconfig and pass it with -Ip." -ForegroundColor Red; exit 1 }

$env:EXPO_PUBLIC_API_URL = "http://$($Ip):$($cfg.SMK_PORTAL_PORT)"
$env:EXPO_PUBLIC_SIM_URL = "http://$($Ip):$($cfg.SMK_SIM_PORT)"
Write-Host "Phone will use $env:EXPO_PUBLIC_API_URL" -ForegroundColor Cyan
Write-Host "Check from the phone's browser first: $env:EXPO_PUBLIC_API_URL/healthz"
Set-Location (Join-Path $Script:Root 'apps\mobile')
# Install the app's packages the first time, and again whenever an upgrade changed them.
$lockHash = (Get-FileHash package-lock.json -Algorithm SHA256).Hash
$marker = 'node_modules\.smk-lock-hash'
if (-not (Test-Path node_modules) -or -not (Test-Path $marker) -or ((Get-Content $marker -Raw).Trim() -ne $lockHash)) {
  Write-Host "Installing the app's packages (a few minutes)..." -ForegroundColor Cyan
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed. See the messages above.' -ForegroundColor Red; exit 1 }
  Set-Content -Path $marker -Value $lockHash -Encoding ASCII
}
npx expo start --port $cfg.SMK_EXPO_PORT --lan
