<#
  Access Monitoring Tool - reach the portal from OUTSIDE the hotel through Cloudflare Tunnel (2.20).
  No public IP, no port forwarding, nothing opened inbound: a small Cloudflare agent (cloudflared) on this server
  makes an OUTGOING connection to Cloudflare, and your own address (for example https://portal.afratech.africa)
  reaches the portal through it. Run as administrator on the server.

  Before: in the Cloudflare dashboard (your domain must use Cloudflare DNS):
    Zero Trust -> Networks -> Tunnels -> Create a tunnel -> Cloudflared -> name it (e.g. "khb-portal") ->
    copy the token shown in the install command (the long text after "service install").
    Then, Public Hostname: subdomain "portal", domain "afratech.africa", Service type HTTP, URL "localhost:8447".
    Recommended: Zero Trust -> Access -> Applications -> add "portal.afratech.africa" and allow only your
    staff e-mail addresses (one-time PIN by e-mail). See docs\EXTERNAL-ACCESS.md.

    .\set-tunnel-access.ps1 -Hostname portal.afratech.africa -Token <the token>     switch it on
    .\set-tunnel-access.ps1 -Show                                                   what is set
    .\set-tunnel-access.ps1 -Disable                                                switch it off

  The token is a secret: it is passed to cloudflared and stored by it in Windows (its service), never written to
  this platform's files or logs. Options: -Port 8447 (the local port Cloudflare's agent uses), -NoSecretPath (only
  with Cloudflare Access in front), -CloudflaredExe <file> (a cloudflared.exe you downloaded yourself),
  -CloudflaredVersion 2026.9.3.
#>
param(
  [string]$Hostname = '',
  [string]$Token = '',
  [int]$Port = 8447,
  [switch]$NoSecretPath,
  [switch]$Disable,
  [switch]$Show,
  [string]$CloudflaredExe = '',
  [string]$CloudflaredVersion = '2026.9.3',
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
function Fail([string]$t) { Write-Host $t -ForegroundColor Red; exit 1 }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator".' }
$file = Join-Path $DataDir 'gateway.config.json'
if (-not (Test-Path $file)) { Fail "Not installed here ($file not found). Install the Access Monitoring Tool first." }
$outsideFile = Join-Path $DataDir 'outside-url.txt'
$cfDir = Join-Path $env:ProgramFiles 'StaffMobileKey\cloudflared'
$cfExe = Join-Path $cfDir 'cloudflared.exe'

function Show-State {
  $c = Get-Content $file -Raw | ConvertFrom-Json
  $t = @($c.listeners | Where-Object { $_.name -eq 'tunnel' })[0]
  if ($t) {
    Write-Host "  Tunnel entrance: http://127.0.0.1:$($t.port) (for Cloudflare's agent on this server only)" -ForegroundColor Green
    Write-Host "  Secret path:     $(if ($t.requireSecretPath) { 'required' } else { 'not required (use Cloudflare Access)' })"
  } else { Write-Host '  Tunnel entrance: off' }
  if (Test-Path $outsideFile) { Write-Host "  Outside address: $((Get-Content $outsideFile -Raw).Trim())" }
  $s = Get-Service cloudflared -ErrorAction SilentlyContinue
  Write-Host "  Cloudflare agent (service cloudflared): $(if ($s) { $s.Status } else { 'not installed' })"
}
if ($Show) { Show-State; exit 0 }

$cfg = Get-Content $file -Raw | ConvertFrom-Json
$listeners = @($cfg.listeners | Where-Object { $_.name -ne 'tunnel' })
if (-not $Disable) {
  if ($Hostname -notmatch '^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$') { Fail 'Give the outside address with -Hostname, for example portal.afratech.africa (no https://, no path).' }
  if ($Port -lt 1024 -or $Port -gt 65535) { Fail '-Port must be between 1024 and 65535.' }
  if (@($listeners | Where-Object { [int]$_.port -eq $Port }).Count) { Fail "Port $Port is already used by the portal; choose another with -Port." }
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne (Get-CimInstance Win32_Service -Filter "Name='StaffMobileKeyGateway'").ProcessId }) { Fail "Another program already uses port $Port; choose another with -Port." }
  $listeners += [pscustomobject][ordered]@{ name = 'tunnel'; host = '127.0.0.1'; port = $Port; allow = @('127.0.0.1', '::1'); requireSecretPath = (-not $NoSecretPath); clientIpHeader = 'cf-connecting-ip'; publicHttps = $true }
}
$cfg.listeners = $listeners

# Check the new settings with the gateway program itself before using them.
$svc = Get-CimInstance Win32_Service -Filter "Name='StaffMobileKeyGateway'"
if (-not $svc) { Fail 'The StaffMobileKeyGateway service is not installed.' }
$node = [regex]::Match($svc.PathName, '--node "([^"]+)"').Groups[1].Value
$script = [regex]::Match($svc.PathName, '--script "([^"]+)"').Groups[1].Value
$tmp = "$file.new"
[IO.File]::WriteAllText($tmp, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
& $node $script --check $tmp
if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force; Fail 'Nothing was changed.' }

if ($Disable) {
  if (Get-Service cloudflared -ErrorAction SilentlyContinue) {
    $exe = if (Test-Path $cfExe) { $cfExe } else { (Get-Command cloudflared -ErrorAction SilentlyContinue).Source }
    if ($exe) { & $exe service uninstall | Out-Null }
  }
  Copy-Item $file "$file.bak" -Force; Move-Item $tmp $file -Force
  Remove-Item $outsideFile -Force -ErrorAction SilentlyContinue
  Restart-Service StaffMobileKeyGateway
  Write-Host 'Outside access through Cloudflare Tunnel is off. Delete the tunnel in the Cloudflare dashboard too.' -ForegroundColor Green
  Show-State; exit 0
}

# ---- cloudflared: Cloudflare's own program, signed by Cloudflare -----------------------------------------------
New-Item -ItemType Directory -Force -Path $cfDir | Out-Null
if ($CloudflaredExe) { Copy-Item $CloudflaredExe $cfExe -Force }
elseif (-not (Test-Path $cfExe)) {
  $url = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
  Write-Host "Downloading cloudflared $CloudflaredVersion from Cloudflare's GitHub releases..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  try { Invoke-WebRequest -Uri $url -OutFile $cfExe -UseBasicParsing }
  catch { Remove-Item $tmp -Force; Fail "Could not download cloudflared ($($_.Exception.Message)). Download cloudflared-windows-amd64.exe yourself from https://github.com/cloudflare/cloudflared/releases and run again with -CloudflaredExe <file>." }
}
$sig = Get-AuthenticodeSignature $cfExe
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Cloudflare') {
  Remove-Item $tmp -Force; Remove-Item $cfExe -Force -ErrorAction SilentlyContinue
  Fail "cloudflared.exe is not signed by Cloudflare ($($sig.Status)); it was deleted and nothing was changed."
}
if (-not $Token -and -not (Get-Service cloudflared -ErrorAction SilentlyContinue)) { Remove-Item $tmp -Force; Fail 'Give the tunnel token from the Cloudflare dashboard with -Token (see the top of this script).' }

Copy-Item $file "$file.bak" -Force; Move-Item $tmp $file -Force
Restart-Service StaffMobileKeyGateway
Start-Sleep -Seconds 3
if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
  Copy-Item "$file.bak" $file -Force; Restart-Service StaffMobileKeyGateway
  Fail "The gateway did not open port $Port; the previous settings are back. See $(Join-Path $DataDir 'logs\gateway.log')."
}
if ($Token) {
  if (Get-Service cloudflared -ErrorAction SilentlyContinue) { & $cfExe service uninstall | Out-Null; Start-Sleep -Seconds 2 }
  # The token goes to cloudflared only (it stores it with its Windows service); it is not echoed or saved here.
  & $cfExe service install $Token | Out-Null
  $Token = $null
  if ($LASTEXITCODE -ne 0) { Fail 'cloudflared could not install its service with this token: copy the token again from the Cloudflare dashboard.' }
}
Start-Sleep -Seconds 5
$s = Get-Service cloudflared -ErrorAction SilentlyContinue
if (-not $s -or $s.Status -ne 'Running') { try { Start-Service cloudflared } catch { } }

$c2 = Get-Content $file -Raw | ConvertFrom-Json
$outside = "https://$Hostname" + $(if ($NoSecretPath) { '' } else { $c2.secretPath })
Set-Content -Path $outsideFile -Value $outside -Encoding ASCII
& icacls $outsideFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:R' | Out-Null

Write-Host ''
Write-Host 'Outside access through Cloudflare Tunnel is on.' -ForegroundColor Green
Write-Host "  In the Cloudflare dashboard the public hostname $Hostname must point to: HTTP  localhost:$Port"
Write-Host "  Outside address to give staff: $outside/" -ForegroundColor Cyan
if (-not $NoSecretPath) { Write-Host '  Keep it like a password: without the secret part the address answers "Not found".' }
Write-Host '  Invitation links made in the portal now also come with this outside address.'
Show-State
