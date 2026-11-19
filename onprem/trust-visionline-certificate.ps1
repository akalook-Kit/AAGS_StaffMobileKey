<#
  2.38.1 Trust the Visionline certificate the connector checks, again.

  - After Visionline's certificate was renewed: reads the new one, shows it, and trusts exactly that one.
  - When Visionline's certificate has EXPIRED and cannot be renewed today (Armel, 18 Nov 2026: expired since the
    property was installed five years ago): after you type ACCEPT, exactly this certificate is trusted although its
    date has passed. Every other certificate is still refused, the connection stays encrypted and checked; only the
    date is not. The portal shows a warning until the certificate is renewed (ASSA ABLOY) and this is run again.

  Run as administrator on the server with the connector:
    Trust-Visionline-Certificate.cmd                       (asks before accepting an expired certificate)
    Trust-Visionline-Certificate.cmd -CertFile C:\vl.crt   (a certificate file given by the Visionline administrator)
    Trust-Visionline-Certificate.cmd -AcceptExpired -Yes   (no question; for a script)
#>
param([string]$CertFile = '', [switch]$AcceptExpired, [switch]$Yes)
$ErrorActionPreference = 'Stop'
function Fail([string]$t) { Write-Host ''; Write-Host $t -ForegroundColor Red; exit 1 }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'Run this as administrator (Trust-Visionline-Certificate.cmd asks for it).' }

$node = Join-Path $env:ProgramFiles 'StaffMobileKey\Runtime\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Fail 'Node.js of the Access Monitoring Tool was not found. Install the Access Monitoring Tool first.' }
$probe = Join-Path $PSScriptRoot 'connector\app\probe.mjs'
if (-not (Test-Path $probe)) { Fail "The connector files are missing next to this script ($probe)." }
$data = Join-Path $env:ProgramData 'StaffMobileKey\Connector'
$cfgFile = Join-Path $data 'connector.config.json'
if (-not (Test-Path $cfgFile)) { Fail 'The connector is not installed on this server (no connector.config.json). Run it on the server where the connector runs.' }
$cfg = (Get-Content $cfgFile -Raw) -replace "^\uFEFF", '' | ConvertFrom-Json
$url = $cfg.visionline.baseUrl
$reports = Join-Path $data 'logs\visionline-probe'
$new = Join-Path $data 'visionline-new.crt'
Remove-Item $new -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Visionline: $url"
if ($CertFile) {
  if (-not (Test-Path $CertFile)) { Fail "File not found: $CertFile" }
  Copy-Item $CertFile $new -Force
} else {
  # Reads the certificate Visionline presents (nothing is sent over that connection).
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $node $probe --url $url --tls-only --save-cert $new --save-leaf --out $reports *> $null
  $ErrorActionPreference = $prev
  if (-not (Test-Path $new)) { Fail "Visionline did not answer at $url. Check that the Visionline service runs, then try again." }
}

$js = "const {X509Certificate}=require('crypto');const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');const b=t.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[];if(b.length!==1){console.log(JSON.stringify({error:'The file must hold exactly one certificate ('+b.length+' found).'}));process.exit(0)}const c=new X509Certificate(b[0]);console.log(JSON.stringify({subject:c.subject.replace(/\n/g,', '),issuer:c.issuer.replace(/\n/g,', '),validFrom:new Date(c.validFrom).toISOString().slice(0,10),validTo:new Date(c.validTo).toISOString().slice(0,10),expired:Date.parse(c.validTo)<Date.now(),fp:c.fingerprint256,ca:c.ca}))"
$info = (& $node -e $js $new) | ConvertFrom-Json
if ($info.error) { Fail $info.error }
Write-Host "  Certificate:  $($info.subject)"
Write-Host "  Issued by:    $($info.issuer)"
Write-Host "  Valid:        $($info.validFrom) to $($info.validTo)$(if ($info.expired) { '   EXPIRED' })" -ForegroundColor $(if ($info.expired) { 'Yellow' } else { 'Gray' })
Write-Host "  SHA-256:      $($info.fp)"
Write-Host ''

$accept = ''
if ($info.expired) {
  if ($info.ca) { Fail 'This file is a CA certificate. An expired certificate can only be accepted as Visionline''s own certificate (run without -CertFile to read it from Visionline).' }
  Write-Host 'This certificate has expired. The proper fix is to have it renewed on the Visionline server (ASSA ABLOY).' -ForegroundColor Yellow
  Write-Host 'Meanwhile the connector can trust EXACTLY this certificate although its date has passed:'
  Write-Host '  - any other certificate is still refused (the SHA-256 above must match), the connection stays encrypted;'
  Write-Host '  - only the expiry date is not checked, for this certificate only;'
  Write-Host '  - the portal shows a warning until the certificate is renewed and this is run again.'
  Write-Host 'If you can, compare the SHA-256 above with the certificate on the Visionline server (certlm.msc, or ask the Visionline administrator).'
  if (-not $AcceptExpired -and -not $Yes) {
    $answer = Read-Host 'Type ACCEPT to trust this expired certificate, or press Enter to stop'
    if ($answer -cne 'ACCEPT') { Remove-Item $new -ErrorAction SilentlyContinue; Write-Host 'Nothing was changed.'; exit 2 }
  } elseif (-not $AcceptExpired) { Fail 'The certificate has expired: add -AcceptExpired to accept it.' }
  $accept = $info.fp
}

# The same check the connector makes, before anything is changed.
$check = @('--url', $url, '--tls-only', '--ca', $new, '--out', $reports)
if ($accept) { $check += @('--accept-expired', $accept) }
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $node $probe @check *> $null
$ok = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prev
if (-not $ok) { Remove-Item $new -ErrorAction SilentlyContinue; Fail "Visionline at $url is not trusted with this certificate (report in $reports). Nothing was changed." }

$target = Join-Path $data 'visionline-ca.crt'
if (Test-Path $target) { Copy-Item $target "$target.previous" -Force }
Move-Item $new $target -Force
$cfg.visionline | Add-Member -NotePropertyName caFile -NotePropertyValue $target -Force
$cfg.visionline | Add-Member -NotePropertyName acceptExpiredSha256 -NotePropertyValue $accept -Force
Copy-Item $cfgFile "$cfgFile.previous" -Force
[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))

$svc = Get-Service StaffMobileKeyConnector -ErrorAction SilentlyContinue
if ($svc) { Restart-Service StaffMobileKeyConnector -Force; Write-Host '  Connector restarted.' }
Write-Host ''
if ($accept) {
  Write-Host 'Done: the connector trusts exactly this EXPIRED certificate. In the portal: Settings -> Visionline should show Reachable: Yes' -ForegroundColor Green
  Write-Host 'within a minute; enter the Visionline password there and press Test and save. Have the certificate renewed, then run this again.' -ForegroundColor Green
} else {
  Write-Host 'Done: the connector trusts exactly this certificate. In the portal: Settings -> Visionline should show Reachable: Yes within a minute.' -ForegroundColor Green
}
exit 0
