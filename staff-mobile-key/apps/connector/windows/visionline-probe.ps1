<#
  Read-only check of the Visionline server from this PC, with the connector's own trust settings.
  It opens one session, sends GET requests only, closes the session, and changes nothing in Visionline.
  The password is typed into the probe and never saved; the report contains no secrets.

    .\visionline-probe.ps1 -TlsOnly
    .\visionline-probe.ps1 -User sym
    .\visionline-probe.ps1 -Url https://localhost/api/v1 -CaFile C:\khb\visionline-ca.crt -User sym
    .\visionline-probe.ps1 -TlsOnly -SaveCert C:\khb\visionline-ca.crt

  Without -Url / -CaFile / -ServerName / -Pin it uses the values of the installed connector, if any.
#>
param(
  [string]$Url = '', [string]$User = '', [string]$AccessId = '', [string]$CaFile = '', [string]$Pin = '', [string]$ServerName = '',
  [string]$SaveCert = '', [string]$Groups = 'Housekeeping,Maintenance,Security,Management,Front Office', [int]$Uuid = 9,
  [switch]$TlsOnly, [string]$NodePath = '', [string]$ClientUuid = ''
)
$ErrorActionPreference = 'Continue'
$cfgFile = Join-Path $env:ProgramData 'StaffMobileKey\Connector\connector.config.json'
$vl = $null
if (Test-Path $cfgFile) { try { $vl = ((Get-Content $cfgFile -Raw) -replace "^\uFEFF", '' | ConvertFrom-Json).visionline } catch { } }
if (-not $Url) { $Url = $(if ($vl -and $vl.baseUrl) { $vl.baseUrl } else { 'https://localhost/api/v1' }) }
if (-not $CaFile -and $vl -and $vl.caFile) { $CaFile = $vl.caFile }
if (-not $ServerName -and $vl -and $vl.servername) { $ServerName = $vl.servername }
if (-not $Pin -and $vl -and $vl.pinSha256) { $Pin = $vl.pinSha256 }
if (-not $NodePath) { $c = Get-Command node -ErrorAction SilentlyContinue; if (-not $c) { Write-Host 'Node.js 22 is needed (https://nodejs.org).' -ForegroundColor Red; exit 1 }; $NodePath = $c.Source }

$a = @((Join-Path $PSScriptRoot 'app\probe.mjs'), '--url', $Url, '--groups', $Groups, '--uuid', "$Uuid", '--out', (Join-Path (Get-Location) 'visionline-probe-report'))
if ($User) { $a += @('--user', $User) }
if ($AccessId) {
  $a += @('--access-id', $AccessId)
  # Use the installed connector's uuid, so Visionline sees the same web client as the connector (one entry to Allow).
  $inst = Join-Path $env:ProgramData 'StaffMobileKey\Connector\installation.json'
  if (-not $ClientUuid -and (Test-Path $inst)) { try { $ClientUuid = (Get-Content $inst -Raw | ConvertFrom-Json).uuid } catch { } }
  if ($ClientUuid) { $a += @('--client-uuid', $ClientUuid) }
}
if ($CaFile) { $a += @('--ca', $CaFile) }
if ($Pin) { $a += @('--pin', $Pin) }
if ($ServerName) { $a += @('--servername', $ServerName) }
if ($SaveCert) { $a += @('--save-cert', $SaveCert) }
if ($TlsOnly) { $a += '--tls-only' }
& $NodePath @a
exit $LASTEXITCODE
