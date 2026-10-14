<#
  Read-only check of a real Visionline server before the connector is installed.
  It opens one Visionline session, sends GET requests only, and closes the session. Nothing is changed.
  The password is typed into the probe (not shown) and is never saved. The report has no secrets.

  Examples (run from the project folder, e.g. C:\khb\staff-mobile-key\staff-mobile-key):
    .\scripts\windows\visionline-probe.ps1 -TlsOnly
    .\scripts\windows\visionline-probe.ps1 -User sym -CaFile C:\khb\visionline-ca.crt
    .\scripts\windows\visionline-probe.ps1 -Url https://192.168.1.50/api/v1 -User sym -SaveCert C:\khb\visionline.crt -TlsOnly

  -Url        Visionline Web API address. Default https://localhost/api/v1 (Visionline on this PC).
  -CaFile     Certificate file that Visionline's certificate must chain to (or the self-signed certificate itself).
  -Pin        Optional SHA-256 fingerprint the certificate must also match.
  -SaveCert   Save the certificate the server presents, so you can verify and then use it with -CaFile.
  -Groups     Visionline user groups to look for (comma-separated).
  -Native     Use Node.js installed on this PC instead of Docker (e.g. on the Visionline PC with the connector).
#>
param(
  [string]$Url = 'https://localhost/api/v1',
  [string]$User = '',
  [string]$AccessId = '',
  [string]$CaFile = '',
  [string]$Pin = '',
  [string]$ServerName = '',
  [string]$SaveCert = '',
  [string]$Groups = 'Housekeeping,Maintenance,Security,Management,Front Office',
  [int]$Uuid = 9,
  [switch]$TlsOnly,
  [switch]$Native
)
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
$ErrorActionPreference = 'Continue'

$reportDir = Join-Path $Script:Root 'visionline-probe-report'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

if ($Native) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js is not installed on this PC. Run without -Native to use Docker.' -ForegroundColor Red; exit 1 }
  $a = @('tsx', 'src/probe.ts', '--url', $Url, '--groups', $Groups, '--uuid', "$Uuid", '--out', $reportDir)
  if ($User) { $a += @('--user', $User) }
  if ($AccessId) { $a += @('--access-id', $AccessId) }
  if ($CaFile) { $a += @('--ca', (Resolve-Path $CaFile).Path) }
  if ($Pin) { $a += @('--pin', $Pin) }
  if ($ServerName) { $a += @('--servername', $ServerName) }
  if ($SaveCert) { $a += @('--save-cert', $SaveCert) }
  if ($TlsOnly) { $a += '--tls-only' }
  Push-Location (Join-Path $Script:Root 'apps\connector')
  npx @a
  $code = $LASTEXITCODE
  Pop-Location
  exit $code
}

# ---- Docker mode: runs the probe from the project image; nothing is installed on this PC ------------------
$cfg = Read-SmkEnv
$image = "$($cfg.COMPOSE_PROJECT_NAME):dev"
docker image inspect $image *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "The image $image is not built yet. Run .\scripts\windows\start.ps1 once first." -ForegroundColor Red; exit 1 }

# Inside the container "localhost" is the container itself: reach this PC through host.docker.internal,
# while still checking the certificate against the original name.
$u = [Uri]$Url
$target = $Url
if ($u.Host -in @('localhost', '127.0.0.1')) {
  $target = $Url -replace [Regex]::Escape("//$($u.Host)"), '//host.docker.internal'
  if (-not $ServerName) { $ServerName = $u.Host }
  Write-Host "Visionline on this PC: connecting via host.docker.internal, checking the certificate for '$ServerName'." -ForegroundColor DarkGray
}

$dockerArgs = @('run', '--rm', '-it', '--add-host', 'host.docker.internal:host-gateway', '-w', '/app/apps/connector', '-v', "${reportDir}:/out")
$probeArgs = @('npx', 'tsx', 'src/probe.ts', '--url', $target, '--groups', $Groups, '--uuid', "$Uuid", '--out', '/out')
if ($CaFile) {
  $caFull = (Resolve-Path $CaFile).Path
  $dockerArgs += @('-v', "$(Split-Path $caFull -Parent):/ca:ro")
  $probeArgs += @('--ca', "/ca/$(Split-Path $caFull -Leaf)")
}
if ($SaveCert) {
  $probeArgs += @('--save-cert', "/out/$(Split-Path $SaveCert -Leaf)")
}
if ($User) { $probeArgs += @('--user', $User) }
if ($AccessId) { $probeArgs += @('--access-id', $AccessId) }
if ($Pin) { $probeArgs += @('--pin', $Pin) }
if ($ServerName) { $probeArgs += @('--servername', $ServerName) }
if ($TlsOnly) { $probeArgs += '--tls-only' }

docker @dockerArgs $image @probeArgs
$code = $LASTEXITCODE
if ($SaveCert) {
  $saved = Join-Path $reportDir (Split-Path $SaveCert -Leaf)
  if ((Test-Path $saved) -and ($saved -ne $SaveCert)) { Move-Item -Force $saved $SaveCert; Write-Host "Certificate saved to $SaveCert" }
}
Write-Host "Reports are in $reportDir"
exit $code
