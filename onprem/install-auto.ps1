<#
  Access Monitoring Tool - what the .msi runs (as SYSTEM, without a window unless asked for).
  It reads the answers given at the start of the installation (%ProgramData%\AccessMonitoringToolSetup\answers.json,
  deleted afterwards) and installs:
    all        the portal and the connector on this server (install-onprem.ps1)
    portal     the portal only; the connector runs on another computer (install-onprem.ps1 -SkipConnector)
    connector  the connector only; the portal is on another computer (connector\install.ps1 with the bundled Node.js)
  Without answers (upgrade, silent installation) it upgrades what is installed, or installs everything.
  Any options typed in SMK_OPTIONS are passed on to install-onprem.ps1.
  Everything is written to a log under C:\ProgramData\StaffMobileKey\setup-logs.
#>
param([Parameter(ValueFromRemainingArguments = $true)] $Rest)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$logDir = Join-Path $env:ProgramData 'StaffMobileKey\setup-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "msi-$(Get-Date -Format yyyyMMdd-HHmmss).log"
try { Start-Transcript -Path $log -Force | Out-Null } catch { }
function Done([int]$code) { try { Stop-Transcript | Out-Null } catch { }; exit $code }

$ansDir = Join-Path $env:ProgramData 'AccessMonitoringToolSetup'
$ansFile = Join-Path $ansDir 'answers.json'
$a = $null
if (Test-Path $ansFile) {
  try {
    $a = Get-Content $ansFile -Raw | ConvertFrom-Json
    if ([datetime]::Parse($a.at).ToUniversalTime() -lt (Get-Date).ToUniversalTime().AddHours(-6)) { Write-Host 'Old answers ignored.'; $a = $null }
  } catch { Write-Host "The answers could not be read: $($_.Exception.Message)"; $a = $null }
}
$mode = if ($a) { [string]$a.mode } elseif (Get-Service StaffMobileKeyPlatform -ErrorAction SilentlyContinue) { 'all' } elseif (Get-Service StaffMobileKeyConnector -ErrorAction SilentlyContinue) { 'connector' } else { 'all' }
Write-Host "Access Monitoring Tool installation: $mode$(if ($a) { ' (answers from the setup window)' } else { '' })"
$opts = @($Rest | Where-Object { $_ -and "$_".Trim() })

try {
  if ($mode -eq 'connector') {
    # ---- The connector only ------------------------------------------------------------------------------------
    $connPkg = Join-Path $here 'connector'
    if (-not (Test-Path (Join-Path $connPkg 'install.ps1'))) { throw 'The connector is missing from this package.' }
    $rt = Join-Path $env:ProgramFiles 'StaffMobileKey\Runtime\node'
    New-Item -ItemType Directory -Force -Path $rt | Out-Null
    & robocopy (Join-Path $here 'runtime\node') $rt /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    $node = Join-Path $rt 'node.exe'
    $cargs = @{ NodePath = $node }
    $dataDir = Join-Path $env:ProgramData 'StaffMobileKey\Connector'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    if ($a) {
      $portal = ([string]$a.portalUrl).TrimEnd('/')
      $u = [Uri]$portal
      # The portal's certificate, read now and checked against the fingerprint confirmed in the setup window.
      $tcp = New-Object Net.Sockets.TcpClient($u.Host, $u.Port)
      $script:seen = $null
      $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, ({ param($s, $c, $ch, $e) $script:seen = $c; $true } -as [Net.Security.RemoteCertificateValidationCallback]))
      $ssl.AuthenticateAsClient($u.Host)
      $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($script:seen)
      $ssl.Dispose(); $tcp.Dispose()
      $fp = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData))).Replace('-', ':')
      if ($a.portalPin -and $fp -ne [string]$a.portalPin) { throw "The portal presented a different certificate ($fp) than the one confirmed in the setup window. Nothing was installed." }
      $cer = Join-Path $dataDir 'platform-from-setup.cer'
      [IO.File]::WriteAllText($cer, "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n")
      $cargs.PlatformUrl = $portal; $cargs.PlatformCaFile = $cer
      if ($a.visionlineUrl) { $cargs.VisionlineUrl = [string]$a.visionlineUrl }
      # Visionline's certificate, read on this computer (trust on first use; verification stays on).
      $vlCert = Join-Path $dataDir 'visionline-certificate.crt'
      $probe = Join-Path $connPkg 'app\probe.mjs'
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & $node $probe --url $cargs.VisionlineUrl --tls-only --save-cert $vlCert --out (Join-Path $logDir 'visionline-probe') *> $null
      $ErrorActionPreference = $prev
      if (Test-Path $vlCert) { $cargs.CaFile = $vlCert } else { Write-Host "Visionline at $($cargs.VisionlineUrl) could not be reached; its certificate can be given later (README)." }
      if ($a.token) {
        Add-Type -AssemblyName System.Security
        $plain = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$a.token), [Text.Encoding]::UTF8.GetBytes('AccessMonitoringTool'), 'LocalMachine'))
        $env:SMK_CONNECTOR_TOKEN = $plain; $plain = $null
        $b = New-Object byte[] 18; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
        $env:SMK_CONNECTOR_ADMIN_PASSWORD = [Convert]::ToBase64String($b)
        if (Test-Path (Join-Path $dataDir 'secrets.enc')) { $cargs.ResetSecrets = $true }
      }
      Set-Content -Path (Join-Path $env:ProgramData 'StaffMobileKey\connector-portal-url.txt') -Value $portal -Encoding ASCII
    }
    $global:LASTEXITCODE = 0
    try { & (Join-Path $connPkg 'install.ps1') @cargs }
    finally { Remove-Item Env:\SMK_CONNECTOR_TOKEN, Env:\SMK_CONNECTOR_ADMIN_PASSWORD -ErrorAction SilentlyContinue }
    $rc = $LASTEXITCODE
    $svc = Get-Service StaffMobileKeyConnector -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { $rc = 0 } elseif (-not $rc) { Write-Host 'The connector service is not running.'; $rc = 1 }
  } else {
    # ---- The portal (and the connector) on this server ---------------------------------------------------------
    $iargs = @{ NoBrowser = $true }
    if ($a) {
      if ($a.lanPort) { $iargs.LanPort = [int]$a.lanPort }
      if ($mode -eq 'all' -and $a.visionlineUrl) { $iargs.VisionlineUrl = [string]$a.visionlineUrl }
      if ($mode -eq 'portal') { $iargs.SkipConnector = $true; if ($a.connectorFrom) { $iargs.ConnectorFrom = [string]$a.connectorFrom } }
    }
    # Options typed in SMK_OPTIONS (e.g. -ServerName smk01 -LanPort 9443 -SkipConnector) come last and win.
    for ($k = 0; $k -lt $opts.Count; $k++) {
      $o = "$($opts[$k])"
      if ($o -notmatch '^-([A-Za-z]+)$') { Write-Host "Option ignored: $o"; continue }
      $name = $Matches[1]
      if ($k + 1 -lt $opts.Count -and "$($opts[$k + 1])" -notmatch '^-[A-Za-z]+$') { $iargs[$name] = "$($opts[$k + 1])"; $k++ } else { $iargs[$name] = $true }
    }
    $global:LASTEXITCODE = 0
    & (Join-Path $here 'install-onprem.ps1') @iargs
    $rc = $LASTEXITCODE
    # 2.17.1 install-onprem.ps1 stops with exit 1 on a real failure; any other code here was left by the last Windows
    # command it ran (sc.exe, icacls...) or by the connector, which is only a note there. What counts is the portal
    # answering. (2.17.0 failed the .msi with error 1722 on such a leftover code.)
    $healthy = $false
    try {
      $pu = (Get-Content (Join-Path $env:ProgramData 'StaffMobileKey\Platform\portal-url.txt') -Raw).Trim()
      for ($t = 0; $t -lt 15 -and -not $healthy; $t++) { try { $healthy = [bool](Invoke-RestMethod -Uri "$pu/healthz" -TimeoutSec 4).ok } catch { Start-Sleep -Seconds 2 } }
    } catch { }
    if ($healthy) {
      if ($rc -and $rc -ne 0) { Write-Host "The portal is running (a step reported code $rc; see the log above)." }
      $rc = 0
    } elseif (-not $rc) { Write-Host 'The portal does not answer.'; $rc = 1 }
  }
} catch {
  Write-Host "The installation stopped: $($_.Exception.Message)" -ForegroundColor Red
  $rc = 1
} finally {
  if (Test-Path $ansFile) { Remove-Item $ansFile -Force -ErrorAction SilentlyContinue }
}
if ($rc -ne 0 -and $null -ne $rc) { Write-Host "Finished with code $rc. Log: $log" } else { Write-Host "Finished. Log: $log" }
Done ([int]($rc -as [int]))
