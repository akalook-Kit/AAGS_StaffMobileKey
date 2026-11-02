<#
  Access Monitoring Tool - let a connector on ANOTHER computer of the hotel network reach this server (2.16).
  Run as administrator on the Access Monitoring Tool server. The portal (Settings -> Connector) writes this command for you.

    .\set-connector-access.ps1 -Show
    .\set-connector-access.ps1 -Allow 192.168.1.50        the connector computer's address (replaces the list)
    .\set-connector-access.ps1 -Remove 192.168.1.50
    .\set-connector-access.ps1 -None                       only a connector on this server (as installed)
    .\set-connector-access.ps1 -StopLocalConnector         stop and disable the connector installed on this server

  What it does:
   - lets only that address use the connector API on the hotel-network port (the outside entrance never does);
   - opens the Windows Firewall for that address on that port (staff PCs and phones are already allowed);
   - saves this server's certificate as gateway.cer (next to this script's data folder) for the connector computer,
     which trusts exactly that certificate (install.ps1 -PlatformCaFile gateway.cer).
  The connector still signs in with its own token; nothing is opened to the internet.
#>
param(
  [string]$Allow = '',
  [string]$Remove = '',
  [switch]$None,
  [switch]$Show,
  [switch]$StopLocalConnector,
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
function Fail([string]$t) { Write-Host $t -ForegroundColor Red; exit 1 }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator".' }
$file = Join-Path $DataDir 'gateway.config.json'
if (-not (Test-Path $file)) { Fail "Not installed here ($file not found). Install Access Monitoring Tool on this server first." }
$cfg = Get-Content $file -Raw | ConvertFrom-Json
$lan = @($cfg.listeners | Where-Object { $_.name -eq 'lan' })[0]
if (-not $lan) { Fail 'The gateway has no hotel-network listener.' }
$cer = Join-Path $DataDir 'gateway.cer'

function Export-Cer {
  # The certificate the gateway presents (public part only, read over TLS; no password or private key is touched).
  try {
    $tcp = New-Object Net.Sockets.TcpClient('127.0.0.1', [int]$lan.port)
    $script:seen = $null
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, ({ param($s, $c, $ch, $e) $script:seen = $c; $true } -as [Net.Security.RemoteCertificateValidationCallback]))
    $ssl.AuthenticateAsClient('localhost')
    $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($script:seen)
    $ssl.Dispose(); $tcp.Dispose()
    [IO.File]::WriteAllText($cer, "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n")
    $fp = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData))).Replace('-', ':')
    Write-Host "  Certificate for the connector computer: $cer"
    Write-Host "  Fingerprint (SHA-256): $fp"
  } catch {
    Write-Host "  Could not save the certificate automatically ($($_.Exception.Message))." -ForegroundColor Yellow
    Write-Host "  Export it by hand: certlm.msc -> Personal -> Certificates -> 'Access Monitoring Tool gateway' -> Export (Base-64 .cer, no private key) to $cer" -ForegroundColor Yellow
  }
}
function Show-State {
  $c = Get-Content $file -Raw | ConvertFrom-Json
  $l = @($c.listeners | Where-Object { $_.name -eq 'lan' })[0]
  $list = @($l.connectorFrom | Where-Object { $_ })
  Write-Host "  Hotel-network port: $($l.port)"
  if ($list.Count) { Write-Host "  Connector on another computer, allowed from: $($list -join ', ')" -ForegroundColor Yellow } else { Write-Host '  Connector: only on this server' }
  $s = Get-Service StaffMobileKeyConnector -ErrorAction SilentlyContinue
  if ($s) { Write-Host "  Connector on this server: $($s.Status) ($($s.StartType))" }
}
if ($Show) { Show-State; exit 0 }

if ($StopLocalConnector) {
  $s = Get-Service StaffMobileKeyConnector -ErrorAction SilentlyContinue
  if ($s) { Stop-Service StaffMobileKeyConnector -Force -ErrorAction SilentlyContinue; Set-Service StaffMobileKeyConnector -StartupType Disabled; Write-Host '  The connector on this server is stopped and will not start with Windows.' -ForegroundColor Green }
  else { Write-Host '  No connector is installed on this server.' }
  if (-not ($Allow -or $Remove -or $None)) { exit 0 }
}

function Test-Address([string]$a) {
  if ($a -notmatch '^\d{1,3}(\.\d{1,3}){3}(/(2[4-9]|3[0-2]))?$' -and $a -notmatch '^[0-9a-fA-F:]+(/1[12][0-9])?$') { Fail "'$a' is not the connector computer's address (for example 192.168.1.50)." }
  $ip = $a.Split('/')[0]
  if ($ip -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $ip -notmatch '^f[cd]') { Fail "$a is not an address of the hotel network (10.x, 172.16-31.x, 192.168.x). A connector never comes from outside." }
}
$list = @($lan.connectorFrom | Where-Object { $_ })
if ($None) { $list = @() }
if ($Allow) { $list = @($Allow.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
if ($Remove) { $list = @($list | Where-Object { $_ -ne $Remove.Trim() }) }
$list = @($list | Select-Object -Unique)
foreach ($a in $list) { Test-Address $a }

if ($list.Count) { $lan | Add-Member -NotePropertyName connectorFrom -NotePropertyValue $list -Force }
elseif ($lan.PSObject.Properties['connectorFrom']) { $lan.PSObject.Properties.Remove('connectorFrom') }

# Check the new settings with the gateway program itself before using them.
$svc = Get-CimInstance Win32_Service -Filter "Name='StaffMobileKeyGateway'"
if (-not $svc) { Fail 'The StaffMobileKeyGateway service is not installed.' }
$node = [regex]::Match($svc.PathName, '--node "([^"]+)"').Groups[1].Value
$script = [regex]::Match($svc.PathName, '--script "([^"]+)"').Groups[1].Value
$tmp = "$file.new"
[IO.File]::WriteAllText($tmp, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
& $node $script --check $tmp
if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force; Fail 'Nothing was changed.' }
Copy-Item $file "$file.bak" -Force
Move-Item $tmp $file -Force

# Firewall: the hotel-network port is already open for private addresses; this rule documents the connector computer.
Get-NetFirewallRule -Group 'Staff Mobile Key','Access Monitoring Tool' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*- connector*' } | Remove-NetFirewallRule
if ($list.Count) {
  New-NetFirewallRule -DisplayName "Access Monitoring Tool - connector computer ($($lan.port))" -Group 'Access Monitoring Tool' -Direction Inbound -Protocol TCP -LocalPort ([int]$lan.port) -RemoteAddress $list -Action Allow | Out-Null
}
Restart-Service StaffMobileKeyGateway
Start-Sleep -Seconds 3
$listening = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$lan.port) -ErrorAction SilentlyContinue).Count -gt 0
if (-not $listening) {
  Copy-Item "$file.bak" $file -Force; Restart-Service StaffMobileKeyGateway
  Fail "The gateway did not start with the new settings; the previous settings are back. See $(Join-Path $DataDir 'logs\gateway.log')."
}
Write-Host 'Saved. The gateway was restarted.' -ForegroundColor Green
if ($list.Count) { Export-Cer }
Show-State
if ($list.Count) {
  Write-Host ''
  Write-Host 'Next, on the connector computer (PowerShell as administrator, in the unzipped connector folder):' -ForegroundColor Cyan
  Write-Host "  .\install.ps1 -PlatformUrl https://$(hostname):$($lan.port) -PlatformCaFile .\gateway.cer -VisionlineUrl https://<Visionline server>/api/v1 -CaFile .\visionline.crt"
  Write-Host '  (Settings -> Connector in the portal shows this command with your addresses filled in.)'
}
