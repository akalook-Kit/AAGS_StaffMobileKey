<#
  Removes the Staff Mobile Key connector service and its program files.
  Run in PowerShell opened with "Run as administrator".

    .\uninstall.ps1              # keeps the data folder (settings, encrypted secrets, logs) for a later reinstall
    .\uninstall.ps1 -RemoveData  # also deletes the data folder (asks first)

  Also disable the connector in the portal (Connector health) so its token can no longer be used.
#>
param(
  [switch]$RemoveData,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Connector'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Connector'),
  [string]$ServiceName = 'StaffMobileKeyConnector'
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Open PowerShell with "Run as administrator".' -ForegroundColor Red; exit 1 }

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') {
    Write-Host 'Stopping the connector (it removes its Visionline callback and closes its session)...'
    Stop-Service -Name $ServiceName -Force
    (Get-Service $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
  }
  & sc.exe delete $ServiceName | Out-Null
  Write-Host "Service $ServiceName removed."
} else { Write-Host "Service $ServiceName is not installed." }

if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Host "Removed $InstallDir" }

if ($RemoveData -and (Test-Path $DataDir)) {
  $answer = Read-Host "Delete $DataDir (settings, encrypted secrets, journal, logs)? Type YES"
  if ($answer -eq 'YES') { Remove-Item $DataDir -Recurse -Force; Write-Host "Removed $DataDir" } else { Write-Host 'Data folder kept.' }
} elseif (Test-Path $DataDir) { Write-Host "Kept $DataDir (reinstalling reuses it; -RemoveData deletes it)." }
Write-Host 'Done. Disable the connector in the portal (Connector health) as well.' -ForegroundColor Green
