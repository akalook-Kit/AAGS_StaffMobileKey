<#
  Staff Mobile Key - change the platform's secrets, then restart it. Run as administrator.
  Press Enter at a prompt to keep the current value. Values are typed, never shown, and stored encrypted
  for this machine (Windows DPAPI).
    - Credential Services user and password (ASSA ABLOY, from Visionline Options -> Mobile Access)
    - JWT signing key (rotating it signs everyone out)
#>
param([string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform'))
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Open PowerShell with "Run as administrator".' -ForegroundColor Red; exit 1 }
Add-Type -AssemblyName System.Security
$entropy = [Text.Encoding]::UTF8.GetBytes('StaffMobileKey.OnPrem.v1')
$file = Join-Path $DataDir 'platform.secrets'
function Read-Secret([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$clear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $entropy, 'LocalMachine')
$map = [ordered]@{}
foreach ($line in ([Text.Encoding]::UTF8.GetString($clear) -split "`n")) { $l = $line.Trim("`r"); if ($l.Contains('=')) { $i = $l.IndexOf('='); $map[$l.Substring(0, $i)] = $l.Substring($i + 1) } }
[Array]::Clear($clear, 0, $clear.Length)
$user = Read-Host "  Credential Services user (Enter = keep $(if ($map['SECRET_CS_TENANT_USER']) { $map['SECRET_CS_TENANT_USER'] } else { 'none' }))"
if ($user) { $map['SECRET_CS_TENANT_USER'] = $user }
$pw = Read-Secret '  Credential Services password (Enter = keep)'
if ($pw) { $map['SECRET_CS_TENANT_PASSWORD'] = $pw }
$rot = Read-Host '  Sign everyone out by changing the JWT key? (y/N)'
if ($rot -eq 'y') { $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $map['JWT_SECRET'] = [Convert]::ToBase64String($b) }
$text = ($map.Keys | ForEach-Object { "$_=$($map[$_])" }) -join "`n"
$bytes = [Text.Encoding]::UTF8.GetBytes($text)
[IO.File]::WriteAllBytes($file, [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'LocalMachine'))
[Array]::Clear($bytes, 0, $bytes.Length); $pw = $null; $text = $null
& icacls $file /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:R' | Out-Null
Restart-Service StaffMobileKeyPlatform
Write-Host 'Saved and restarted. Connector health -> "Credential Services" shows whether the account answers.' -ForegroundColor Green
