<#
  Signs the Staff Mobile Key .msi with your code-signing certificate, so Windows shows your company as the publisher
  (unsigned installers show "Unknown publisher" and SmartScreen warnings). Needs the Windows SDK's signtool.exe.

    .\sign-msi.ps1 -Msi .\StaffMobileKey-Server-2.12.0.msi -Pfx C:\certs\codesign.pfx
    .\sign-msi.ps1 -Msi .\StaffMobileKey-Server-2.12.0.msi -Thumbprint 0123ABCD...   (certificate in the Windows store / USB token)
#>
param(
  [Parameter(Mandatory)][string]$Msi,
  [string]$Pfx,
  [string]$Thumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found. Install the Windows SDK ("Signing Tools for Desktop Apps").' }
$sa = @('sign', '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256', '/d', 'Staff Mobile Key Server')
if ($Pfx) { $pw = Read-Host 'Certificate password' -AsSecureString; $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)); $sa += @('/f', $Pfx, '/p', $plain) }
elseif ($Thumbprint) { $sa += @('/sha1', $Thumbprint) }
else { $sa += '/a' }
& $signtool.FullName @args $Msi
if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
& $signtool.FullName verify /pa /v $Msi | Select-Object -Last 3
