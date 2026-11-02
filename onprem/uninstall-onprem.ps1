<#
  Staff Mobile Key - remove the on-premises services (platform, gateway, connector, database), the firewall
  rules, the desktop shortcut and the program files. Run as administrator (or Uninstall.cmd).

  The DATA is KEPT unless you add -RemoveData: C:\ProgramData\StaffMobileKey (the database, settings,
  encrypted secrets, logs and the database copies). Reinstalling with Install.cmd uses it again.
  -RemoveData deletes it after you type YES; copy the backups folder somewhere else first if you need it.
#>
param(
  [switch]$RemoveData,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Platform'),
  [string]$RuntimeDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Runtime'),
  [string]$DataRoot = (Join-Path $env:ProgramData 'StaffMobileKey')
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Run Uninstall.cmd, or open PowerShell with "Run as administrator".' -ForegroundColor Red; exit 1 }
if ($RemoveData) {
  $ok = Read-Host "Delete ALL Staff Mobile Key data in $DataRoot (database, settings, logs and database copies)? Type YES"
  if ($ok -ne 'YES') { Write-Host 'Nothing removed.'; exit 1 }
}
foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform', 'StaffMobileKeyConnector', 'StaffMobileKeyDatabase') {
  $s = Get-Service $svc -ErrorAction SilentlyContinue
  if ($s) {
    if ($s.Status -ne 'Stopped') { Stop-Service $svc -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
    & sc.exe delete $svc | Out-Null
    Write-Host "Removed service $svc"
  }
}
Get-NetFirewallRule -Group 'Staff Mobile Key' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Unregister-ScheduledTask -TaskName 'Staff Mobile Key backup' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Staff Mobile Key.url') -Force -ErrorAction SilentlyContinue
Get-ChildItem Cert:\LocalMachine\My -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -eq 'Staff Mobile Key gateway' } | Remove-Item -ErrorAction SilentlyContinue
# This script may run from the installed folder: copy-out first, then remove the program files.
Set-Location $env:TEMP
foreach ($d in $InstallDir, "$InstallDir.previous", "$InstallDir.failed", (Join-Path $env:ProgramFiles 'StaffMobileKey\Connector'), $RuntimeDir) {
  if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "Removed $d" }
}
$root = Join-Path $env:ProgramFiles 'StaffMobileKey'
if ((Test-Path $root) -and -not (Get-ChildItem $root -Force)) { Remove-Item $root -Force }
if ($RemoveData) { Remove-Item $DataRoot -Recurse -Force; Write-Host "Removed $DataRoot" }
else { Write-Host "Kept the data in $DataRoot (database, settings, copies). Install.cmd uses it again; -RemoveData deletes it." }
Write-Host 'Done.' -ForegroundColor Green
