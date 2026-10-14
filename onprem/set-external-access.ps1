<#
  Staff Mobile Key - who may reach the platform from OUTSIDE the hotel, changed without reinstalling.
  Run as administrator on the server. The public IP addresses are settings, not part of the program:
  they live in C:\ProgramData\StaffMobileKey\Platform\gateway.config.json and in the Windows Firewall rule
  "Staff Mobile Key - external", and this script keeps both in step.

    .\set-external-access.ps1 -Show
    .\set-external-access.ps1 -ExternalPort 9443 -AllowExternal "41.202.219.10/32"      open, or replace the list
    .\set-external-access.ps1 -AddAddress 196.201.10.4                                  add one address or range
    .\set-external-access.ps1 -RemoveAddress 196.201.10.4                               remove one
    .\set-external-access.ps1 -NewSecretPath                                            make a new secret path
    .\set-external-access.ps1 -Disable                                                  close the external entrance

  On the hotel firewall/router, forward TCP <public IP>:443 to <this server>:<ExternalPort>. Nothing else.
#>
param(
  [int]$ExternalPort = 0,
  [string]$AllowExternal = '',
  [string]$AddAddress = '',
  [string]$RemoveAddress = '',
  [switch]$NewSecretPath,
  [switch]$Disable,
  [switch]$Show,
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
function Fail([string]$t) { Write-Host $t -ForegroundColor Red; exit 1 }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator".' }
$file = Join-Path $DataDir 'gateway.config.json'
if (-not (Test-Path $file)) { Fail "Not installed here ($file not found). Run install-onprem.ps1 first." }
$cfg = Get-Content $file -Raw | ConvertFrom-Json
$lan = @($cfg.listeners | Where-Object { $_.name -eq 'lan' })[0]
$ext = @($cfg.listeners | Where-Object { $_.name -eq 'external' })[0]

function Show-State {
  $c = Get-Content $file -Raw | ConvertFrom-Json
  $e = @($c.listeners | Where-Object { $_.name -eq 'external' })[0]
  $l = @($c.listeners | Where-Object { $_.name -eq 'lan' })[0]
  Write-Host "  Hotel network:  port $($l.port), private addresses only"
  if ($e) {
    Write-Host "  From outside:   port $($e.port), only from: $(@($e.allow) -join ', ')" -ForegroundColor Yellow
    Write-Host "  Secret path:    $($c.secretPath)/   (address: https://<hotel public IP>$($c.secretPath)/)"
  } else { Write-Host '  From outside:   closed' }
}
if ($Show) { Show-State; exit 0 }

function Test-Address([string]$a) {
  if ($a -notmatch '^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$' -and $a -notmatch '^[0-9a-fA-F:]+(/\d{1,3})?$') { Fail "'$a' is not an IP address or range (for example 41.202.219.10 or 41.202.219.0/24)." }
  if ($a -match '^0\.0\.0\.0/0$|^::/0$') { Fail 'Allowing every address would defeat the allow-list; give the hotel''s own public addresses.' }
}
$list = if ($ext) { @($ext.allow) } else { @() }
if ($AllowExternal) { $list = @($AllowExternal.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
if ($AddAddress) { $list = @($list) + @($AddAddress.Trim()) }
if ($RemoveAddress) { $list = @($list | Where-Object { $_ -ne $RemoveAddress.Trim() -and $_ -ne "$($RemoveAddress.Trim())/32" }) }
$list = @($list | Select-Object -Unique)
foreach ($a in $list) { Test-Address $a }
$port = if ($ExternalPort -gt 0) { $ExternalPort } elseif ($ext) { [int]$ext.port } else { 0 }

$listeners = @($lan)
if (-not $Disable) {
  if ($port -le 0) { Fail 'Give the port the hotel firewall forwards to, with -ExternalPort (for example 9443).' }
  if ($port -eq [int]$lan.port) { Fail "-ExternalPort must differ from the hotel-network port $($lan.port)." }
  if (-not $list.Count) { Fail 'Give at least one public address with -AllowExternal or -AddAddress.' }
  $listeners += [pscustomobject][ordered]@{ name = 'external'; host = '0.0.0.0'; port = $port; tls = $lan.tls; allow = $list; requireSecretPath = $true }
}
$cfg.listeners = $listeners
if ($NewSecretPath) {
  $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $cfg.secretPath = '/k-' + ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Write-Host '  New secret path made. Old links and app builds with the old path stop working.' -ForegroundColor Yellow
}
# Check the new settings with the gateway program itself before using them.
$svc = Get-CimInstance Win32_Service -Filter "Name='StaffMobileKeyGateway'"
if (-not $svc) { Fail 'The StaffMobileKeyGateway service is not installed. Run install-onprem.ps1 first.' }
$node = [regex]::Match($svc.PathName, '--node "([^"]+)"').Groups[1].Value
$script = [regex]::Match($svc.PathName, '--script "([^"]+)"').Groups[1].Value
$tmp = "$file.new"
[IO.File]::WriteAllText($tmp, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
& $node $script --check $tmp
if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force; Fail 'Nothing was changed.' }
Copy-Item $file "$file.bak" -Force
Move-Item $tmp $file -Force

Get-NetFirewallRule -Group 'Staff Mobile Key' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Staff Mobile Key - external*' } | Remove-NetFirewallRule
if (-not $Disable) {
  New-NetFirewallRule -DisplayName "Staff Mobile Key - external ($port)" -Group 'Staff Mobile Key' -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress $list -Action Allow | Out-Null
}
Restart-Service StaffMobileKeyGateway
Start-Sleep -Seconds 3
$listening = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$lan.port) -ErrorAction SilentlyContinue).Count -gt 0
if (-not $listening) {
  Copy-Item "$file.bak" $file -Force; Restart-Service StaffMobileKeyGateway
  Fail "The gateway did not start with the new settings; the previous settings are back. See $(Join-Path $DataDir 'logs\gateway.log')."
}
Write-Host 'Saved. The gateway was restarted.' -ForegroundColor Green
Show-State
