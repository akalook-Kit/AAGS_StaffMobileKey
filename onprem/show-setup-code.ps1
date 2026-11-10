# 2.33.1 Shows the one-time code of the first-run setup page in a window (English and French), copies it to the
# clipboard and offers to open the setup page with the code filled in. Runs as administrator (Show-SetupCode.cmd):
# the file is readable by administrators only, so opening it with Notepad from a normal window fails.
Add-Type -AssemblyName System.Windows.Forms
$data = Join-Path $env:ProgramData 'StaffMobileKey\Platform'
$file = Join-Path $data 'setup-code.txt'
$title = 'Access Monitoring Tool'
if (-not (Test-Path $file)) {
  [void][System.Windows.Forms.MessageBox]::Show(
    "There is no setup code: this server is already set up (sign in to the portal), or the installation did not finish.`r`n`r`n" +
    "Il n'y a pas de code : ce serveur est deja configure (connectez-vous au portail), ou l'installation n'est pas terminee.",
    $title, 'OK', 'Information')
  exit 0
}
$code = (Get-Content $file -TotalCount 1).Trim()
try { Set-Clipboard -Value $code } catch { }
$url = 'http://127.0.0.1:47300'
$pf = Join-Path $data 'portal-url.txt'
if (Test-Path $pf) { $u = (Get-Content $pf -TotalCount 1).Trim(); if ($u -match '^http://127\.0\.0\.1:\d+$') { $url = $u } }
$answer = [System.Windows.Forms.MessageBox]::Show(
  "Setup code / Code de configuration :`r`n`r`n        $code`r`n`r`n" +
  "It is copied to the clipboard. Open the first-run setup page now?`r`n" +
  "Il est copie dans le presse-papiers. Ouvrir maintenant la page de premiere configuration ?",
  $title, 'YesNo', 'Information')
if ($answer -eq 'Yes') { Start-Process "$url/#code=$code" }
