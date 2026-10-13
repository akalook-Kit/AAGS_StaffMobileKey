<#
  Changes the platform connector token and/or the local status page password, then restarts the service.
  Run in PowerShell opened with "Run as administrator". Press Enter at a prompt to keep the current value.
  Visionline passwords are not entered here: use the portal (Settings -> Visionline), which encrypts them
  for this connector, or the status page.
#>
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Connector'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Connector'),
  [string]$ServiceName = 'StaffMobileKeyConnector'
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Open PowerShell with "Run as administrator".' -ForegroundColor Red; exit 1 }
function Read-Secret([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$svcInfo = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $svcInfo) { Write-Host "Service $ServiceName is not installed. Run install.ps1." -ForegroundColor Red; exit 1 }
$node = [regex]::Match($svcInfo.PathName, '--node "([^"]+)"').Groups[1].Value
if (-not $node) { $node = (Get-Command node).Source }

$token = Read-Secret 'New platform connector token (Enter = keep)'
$pw = Read-Secret 'New status page password, at least 10 characters (Enter = keep)'
if ($pw) { $again = Read-Secret 'Same password again'; if ($pw -ne $again -or $pw.Length -lt 10) { Write-Host 'Passwords differ or are too short. Nothing changed.' -ForegroundColor Red; exit 1 } }
if (-not $token -and -not $pw) { Write-Host 'Nothing to change.'; exit 0 }

Stop-Service -Name $ServiceName -Force
(Get-Service $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
$env:CONNECTOR_CONFIG = Join-Path $DataDir 'connector.config.json'
$prevEnc = $OutputEncoding
$OutputEncoding = New-Object Text.UTF8Encoding $false
try { (@{ platformToken = $token; adminPassword = $pw } | ConvertTo-Json -Compress) | & $node (Join-Path $InstallDir 'app\connector.mjs') set-secrets }
finally { $OutputEncoding = $prevEnc; Remove-Item Env:\CONNECTOR_CONFIG -ErrorAction SilentlyContinue; $token = $null; $pw = $null; $again = $null }
& icacls $DataDir /grant '*S-1-5-19:(OI)(CI)M' /T | Out-Null
Start-Service -Name $ServiceName
Write-Host 'Saved and restarted.' -ForegroundColor Green
