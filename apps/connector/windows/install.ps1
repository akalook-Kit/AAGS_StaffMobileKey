<#
  Installs (or upgrades) the Staff Mobile Key hotel connector as a Windows service.
  Run in PowerShell opened with "Run as administrator", from the unzipped connector folder.

  First installation, testing on your own PC against the simulator:
    .\install.ps1 -PlatformUrl http://localhost:14080 -VisionlineUrl https://localhost:14443/api/v1 `
                  -CaFile C:\khb\staff-mobile-key\staff-mobile-key\local-test\visionline-sim-ca.crt -AdminPort 14091

  First installation on the Visionline PC:
    .\install.ps1 -PlatformUrl https://<your platform address> -CaFile C:\khb\visionline-ca.crt

  Upgrade (keeps the settings, keys and passwords already stored):
    .\install.ps1

  -PlatformUrl     Address of the platform (portal) the connector reports to.
  -VisionlineUrl   Visionline Web API. Default https://localhost/api/v1 (Visionline on this PC).
  -CaFile          Certificate that Visionline's certificate must chain to (see VISIONLINE-PROBE in the docs).
  -ServerName      Name in Visionline's certificate, when it is not the host name in -VisionlineUrl.
  -PinSha256       Optional SHA-256 fingerprint the Visionline certificate must also match.
  -AdminPort       Port of the local status page on 127.0.0.1. Default 8090.
  -ReadOnly        Never change Visionline (no issue/revoke/user groups). For trying it against a live system.
  -ReadWrite       Switch read-only mode off again.
  -NoWatch         Do not watch Visionline (cancelled cards, refused doors, battery alarms). Use it on a
                   Visionline that is not the hotel's own, so its lock events are not stored.
  -Watch           Switch the watch on again.
  -ResetSecrets    Ask again for the platform token and the local admin password.
  -NodePath        node.exe to use, if it is not the one on PATH.

  Nothing here opens an inbound port: the connector only makes outbound connections, and its status page
  listens on 127.0.0.1.
#>
param(
  [string]$PlatformUrl = '',
  [string]$VisionlineUrl = '',
  [string]$CaFile = '',
  [string]$ServerName = '',
  [string]$PinSha256 = '',
  [int]$AdminPort = 0,
  [switch]$ReadOnly,
  [switch]$ReadWrite,
  [switch]$NoWatch,
  [switch]$Watch,
  [switch]$ResetSecrets,
  [string]$NodePath = '',
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Connector'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Connector'),
  [string]$ServiceName = 'StaffMobileKeyConnector'
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
function Write-Step([string]$t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { Write-Host ""; Write-Host $t -ForegroundColor Red; exit 1 }
function Read-Secret([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Write-Utf8NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

# ---- Checks -------------------------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator" and run this again.' }
if (-not (Test-Path (Join-Path $Here 'app\connector.mjs'))) { Fail "Run this from the unzipped connector folder (app\connector.mjs not found next to install.ps1)." }

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Fail "Node.js 22 LTS is not installed. Install it for all users from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), open a new PowerShell, and run this again." }
  $NodePath = $cmd.Source
}
# nvm-windows makes C:\Program Files\nodejs a link into the user profile; the service needs the real location.
$nodeDir = Get-Item (Split-Path $NodePath -Parent)
if ($nodeDir.Target) { $NodePath = Join-Path (@($nodeDir.Target)[0]) 'node.exe' }
$ver = (& $NodePath --version).Trim().TrimStart('v')
if ([int]($ver.Split('.')[0]) -lt 22) { Fail "Node.js $ver found at $NodePath; version 22 or newer is needed." }
if ($NodePath -like "$env:SystemDrive\Users\*") {
  Fail "node.exe is inside a user profile ($NodePath), which the service account cannot read. Either install Node.js 22 LTS for all users from https://nodejs.org, or unzip the Node.js 22 Windows .zip to a folder such as C:\khb\node22 and pass -NodePath C:\khb\node22\node.exe"
}
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { Fail "The .NET Framework 4 C# compiler (csc.exe) was not found. It is part of Windows 10/11; enable '.NET Framework 4.8' in Windows Features." }

$newVersion = (Get-Content (Join-Path $Here 'VERSION') -TotalCount 1).Trim()
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
Write-Host "Staff Mobile Key connector $newVersion" -ForegroundColor Green
Write-Host ("  " + $(if ($svc) { "Upgrading the installed service $ServiceName" } else { "New installation as service $ServiceName" }))
Write-Host "  Program: $InstallDir"
Write-Host "  Data:    $DataDir (settings, encrypted secrets, journal, logs)"
Write-Host "  Node.js: $NodePath ($ver)"

# ---- Stop the running service (upgrade) --------------------------------------------------------------------
if ($svc -and $svc.Status -ne 'Stopped') {
  Write-Step 'Stopping the running connector'
  Stop-Service -Name $ServiceName -Force
  (Get-Service $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
}

# ---- Data folder: settings and permissions ------------------------------------------------------------------
Write-Step 'Settings'
New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir 'logs') | Out-Null
# Only SYSTEM, Administrators and the service account (LOCAL SERVICE) can read the data folder.
& icacls $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Could not set permissions on $DataDir." }

$cfgFile = Join-Path $DataDir 'connector.config.json'
$old = $null
if (Test-Path $cfgFile) { $old = (Get-Content $cfgFile -Raw) -replace "^\uFEFF", '' | ConvertFrom-Json }
function Pick($bound, $value, $existing, $default) { if ($bound) { return $value } elseif ($null -ne $existing -and "$existing" -ne '') { return $existing } else { return $default } }
$b = $PSBoundParameters
if ($CaFile) {
  if (-not (Test-Path $CaFile)) { Fail "Certificate file not found: $CaFile" }
  $caTarget = Join-Path $DataDir 'visionline-ca.crt'
  if ((Resolve-Path $CaFile).Path -ne $caTarget) { Copy-Item $CaFile $caTarget -Force }
  $CaFile = $caTarget
}
$platform = Pick $b.ContainsKey('PlatformUrl') $PlatformUrl $(if ($old) { $old.platformUrl }) ''
if (-not $platform) { Fail 'Give the platform address with -PlatformUrl (for testing on this PC: http://localhost:14080).' }
$readOnlyValue = $(if ($ReadOnly) { $true } elseif ($ReadWrite) { $false } elseif ($old -and $old.visionline) { [bool]$old.visionline.readOnly } else { $false })
$watchValue = $(if ($NoWatch) { $false } elseif ($Watch) { $true } elseif ($old -and $old.visionline -and $null -ne $old.visionline.watch) { [bool]$old.visionline.watch } else { $true })
$cfg = [ordered]@{
  platformUrl = $platform.TrimEnd('/')
  dataDir     = $DataDir
  localAdmin  = [ordered]@{ host = '127.0.0.1'; port = [int](Pick ($AdminPort -gt 0) $AdminPort $(if ($old -and $old.localAdmin) { $old.localAdmin.port }) 8090) }
  visionline  = [ordered]@{
    baseUrl        = Pick $b.ContainsKey('VisionlineUrl') $VisionlineUrl $(if ($old -and $old.visionline) { $old.visionline.baseUrl }) 'https://localhost/api/v1'
    caFile         = Pick $b.ContainsKey('CaFile') $CaFile $(if ($old -and $old.visionline) { $old.visionline.caFile }) ''
    pinSha256      = Pick $b.ContainsKey('PinSha256') $PinSha256 $(if ($old -and $old.visionline) { $old.visionline.pinSha256 }) ''
    servername     = Pick $b.ContainsKey('ServerName') $ServerName $(if ($old -and $old.visionline) { $old.visionline.servername }) ''
    revokeStrategy = Pick $false '' $(if ($old -and $old.visionline) { $old.visionline.revokeStrategy }) 'checkoutPerDoor'
    watch          = $watchValue
    readOnly       = $readOnlyValue
  }
  heartbeatSec = 15
}
Write-Utf8NoBom $cfgFile ($cfg | ConvertTo-Json -Depth 5)
Write-Host "  Platform:   $($cfg.platformUrl)"
Write-Host "  Visionline: $($cfg.visionline.baseUrl)$(if ($cfg.visionline.caFile) { "  (trusting $($cfg.visionline.caFile))" })"
Write-Host "  Status page: http://127.0.0.1:$($cfg.localAdmin.port)/"
if (-not $watchValue) { Write-Host "  Visionline watch: OFF (no cancelled-card, wrong-door or battery events are read)." -ForegroundColor Yellow }
if ($readOnlyValue) { Write-Host "  READ-ONLY: the connector will not issue, revoke or create anything in Visionline." -ForegroundColor Yellow }

# ---- Program files and the service host ------------------------------------------------------------------
Write-Step 'Program files'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $Here 'app') $InstallDir -Recurse -Force
Copy-Item (Join-Path $Here 'service') $InstallDir -Recurse -Force
Copy-Item (Join-Path $Here 'VERSION') $InstallDir -Force
$exe = Join-Path $InstallDir 'StaffMobileKeyConnector.exe'
# The service host is compiled here from service\ConnectorService.cs with the compiler included in Windows.
& $csc /nologo /target:exe /optimize+ "/out:$exe" /reference:System.ServiceProcess.dll (Join-Path $InstallDir 'service\ConnectorService.cs')
if ($LASTEXITCODE -ne 0) { Fail 'Building the service host failed (see the compiler messages above).' }
& icacls $InstallDir /grant '*S-1-5-19:(OI)(CI)RX' | Out-Null
Write-Host "  Installed in $InstallDir"

# ---- Secrets: platform token and local admin password -----------------------------------------------------
$adminPw = $null
if ($ResetSecrets -or -not (Test-Path (Join-Path $DataDir 'secrets.enc'))) {
  Write-Step 'Secrets (typed here, stored encrypted on this PC only)'
  Write-Host '  Platform connector token: in the portal, Connector health -> Register a connector, copy the token.'
  Write-Host '  Press Enter to skip; you can paste it later on the status page.'
  $token = Read-Secret '  Platform connector token'
  do {
    $adminPw = Read-Secret '  New password for the local status page (user "admin", at least 10 characters)'
    $again = Read-Secret '  Same password again'
    if ($adminPw -ne $again -or $adminPw.Length -lt 10) { Write-Host '  The passwords differ or are shorter than 10 characters. Try again.' -ForegroundColor Yellow }
  } while ($adminPw -ne $again -or $adminPw.Length -lt 10)
  $json = @{ platformToken = $token; adminPassword = $adminPw } | ConvertTo-Json -Compress
  $env:CONNECTOR_CONFIG = $cfgFile
  $prevEnc = $OutputEncoding
  $OutputEncoding = New-Object Text.UTF8Encoding $false
  try { $json | & $NodePath (Join-Path $InstallDir 'app\connector.mjs') set-secrets } finally { $OutputEncoding = $prevEnc }
  $saved = $LASTEXITCODE
  $json = $null; $token = $null; $again = $null
  Remove-Item Env:\CONNECTOR_CONFIG -ErrorAction SilentlyContinue
  if ($saved -ne 0) { Fail 'Storing the secrets failed (see above).' }
}
# Files created above by this administrator session must stay readable by the service account.
& icacls $DataDir /grant '*S-1-5-19:(OI)(CI)M' /T | Out-Null

# ---- Windows service ----------------------------------------------------------------------------------
Write-Step 'Windows service'
$bin = "`"$exe`" --node `"$NodePath`" --script `"$(Join-Path $InstallDir 'app\connector.mjs')`" --config `"$cfgFile`" --logs `"$(Join-Path $DataDir 'logs')`""
if (-not $svc) {
  New-Service -Name $ServiceName -BinaryPathName $bin -DisplayName 'Staff Mobile Key Connector' -StartupType Automatic `
    -Description 'Connects the hotel Visionline system to the Staff Mobile Key platform. Outbound connections only.' | Out-Null
} else {
  $r = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" | Invoke-CimMethod -MethodName Change -Arguments @{ PathName = $bin }
  if ($r.ReturnValue -ne 0) { Fail "Updating the service failed (code $($r.ReturnValue))." }
}
# Least privilege: run as LOCAL SERVICE (no password, no network credentials, no admin rights).
$r = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
if ($r.ReturnValue -ne 0) { Fail "Setting the service account failed (code $($r.ReturnValue))." }
& sc.exe config $ServiceName start= delayed-auto | Out-Null
& sc.exe failure $ServiceName reset= 3600 actions= restart/10000/restart/30000/restart/60000 | Out-Null
try {
  Start-Service -Name $ServiceName
  (Get-Service $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
} catch {
  Fail "The service did not start: $($_.Exception.Message)`nLook at $(Join-Path $DataDir 'logs\connector.log') and the Windows Event Viewer (Windows Logs -> Application)."
}
Write-Host "  Service $ServiceName is running as LOCAL SERVICE, starts with Windows."

# ---- Check ------------------------------------------------------------------------------------------
Write-Step 'Checking'
Start-Sleep -Seconds 8
$log = Join-Path $DataDir 'logs\connector.log'
if (Test-Path $log) { Get-Content $log -Tail 8 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
if ($adminPw) {
  try {
    $auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("admin:$adminPw"))
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.localAdmin.port)/health.json" -Headers @{ Authorization = $auth } -TimeoutSec 5
    Write-Host ("  Status {0}. Visionline reachable: {1}. Property credentials stored: {2}." -f $h.status, $h.visionlineReachable, $h.credentialsConfigured)
  } catch { Write-Host "  The status page did not answer yet; open it in a minute." -ForegroundColor Yellow }
  $adminPw = $null
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Status page:  http://127.0.0.1:$($cfg.localAdmin.port)/  (user admin)"
Write-Host "  Logs:         $log"
Write-Host "  In the portal: Connector health shows this connector Online. Then enter the Visionline property"
Write-Host "  credentials in Settings -> Visionline (they are encrypted for this connector), and run discovery."
Write-Host "  Change the token or password later: .\set-secrets.ps1    Remove: .\uninstall.ps1"
exit 0
