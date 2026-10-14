<#
  Staff Mobile Key - remove the on-premises platform services, firewall rules and backup task.
  The database and C:\ProgramData\StaffMobileKey\Platform (settings, secrets, logs, backups) are KEPT unless
  you add -RemoveData. The connector is removed separately with connector\uninstall.ps1.
#>
param([switch]$RemoveData, [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Platform'), [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform'))
$ErrorActionPreference = 'Stop'
foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform') {
  $s = Get-Service $svc -ErrorAction SilentlyContinue
  if ($s) { if ($s.Status -ne 'Stopped') { Stop-Service $svc -Force }; & sc.exe delete $svc | Out-Null; Write-Host "Removed service $svc" }
}
Get-NetFirewallRule -Group 'Staff Mobile Key' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Unregister-ScheduledTask -TaskName 'Staff Mobile Key backup' -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
if ($RemoveData) {
  $ok = Read-Host "Delete $DataDir (secrets, logs and BACKUPS)? The database itself stays in PostgreSQL. Type YES"
  if ($ok -eq 'YES') { Remove-Item $DataDir -Recurse -Force }
}
Write-Host 'Done. To delete the database too: in psql as postgres, DROP DATABASE smk; DROP ROLE smk;'
