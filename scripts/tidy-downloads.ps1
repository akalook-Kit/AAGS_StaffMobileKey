<#
  Access Monitoring Tool - tidy the Downloads folder.

  1. Finds the files of this project in Downloads (installers, project zips, checksums, manuals, screenshots),
     including the copies the browser numbered "(1)", "(2)", ... "(16)".
  2. Keeps the newest of each (newest version, or newest download) in  Downloads\Access Monitoring Tool,
     with its clean name (no "(16)").
  3. Puts every older file into ONE zip:  Downloads\Access Monitoring Tool\old-downloads-<date>.zip
     and checks that the zip holds every file, byte for byte in size.
  4. Lists the old files and ASKS before deleting them. Nothing is deleted without your "YES".

  Run (PowerShell, as your normal user):
    powershell -ExecutionPolicy Bypass -File .\tidy-downloads.ps1
  Only look, change nothing:
    powershell -ExecutionPolicy Bypass -File .\tidy-downloads.ps1 -ListOnly
#>
param(
  [string]$Folder = (Join-Path $env:USERPROFILE 'Downloads'),
  [switch]$ListOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$dest = Join-Path $Folder 'Access Monitoring Tool'
$dup = '(?: \(\d+\))?'   # the browser's " (16)"
$versioned = @(
  "^(AccessMonitoringTool-[A-Za-z]+-)(\d+\.\d+\.\d+)$dup(\.msi)$",
  "^(access-monitoring-tool-project-)(\d+\.\d+\.\d+)$dup(\.zip)$",
  "^(SHA256SUMS-)(\d+\.\d+\.\d+)$dup(\.txt)$"
)
$docs = "^(SHA256SUMS|USER-MANUAL|QUICK-START|GIT|BATTERY-MAINTENANCE|EXTERNAL-ACCESS|MONITORING|SECURITY-AND-COMPLIANCE|SECURITY-REVIEW-[\d.]+|TESTERS|K-HOTEL-BANA|VISIONLINE-DATA|INSTALL[\w-]*|ONPREM[\w-]*)$dup(\.pdf|\.txt|\.md)$"
$shots = "^(demo-and-testers-page|feedback-button|sign-in-desktop|sign-in-phone|tester-view|verify-extend|reports|reports-fr|setup-vl|setup-portal|setup28|login-fr|alerts|tip-menu|tip-tile|menu-open|overview|guest|holders)$dup(\.png)$"

# Files already kept in "Access Monitoring Tool" (an earlier run) count when choosing the newest, so a second run
# never moves an older version over the one kept before.
$files = @(Get-ChildItem -LiteralPath $Folder -File)
if (Test-Path -LiteralPath $dest) { $files += @(Get-ChildItem -LiteralPath $dest -File | Where-Object { $_.Name -notlike 'old-downloads-*.zip' }) }
$found = @()
foreach ($f in $files) {
  $n = $f.Name; $hit = $null
  foreach ($re in $versioned) { if ($n -match $re) { $hit = [pscustomobject]@{ File = $f; Group = $Matches[1] + $Matches[3]; Clean = $Matches[1] + $Matches[2] + $Matches[3]; Version = [version]$Matches[2]; Kind = 'versioned' }; break } }
  if (-not $hit -and $n -match $docs) { $hit = [pscustomobject]@{ File = $f; Group = $Matches[1] + $Matches[2]; Clean = $Matches[1] + $Matches[2]; Version = $null; Kind = 'document' } }
  if (-not $hit -and $n -match $shots) { $hit = [pscustomobject]@{ File = $f; Group = 'screenshot:' + $n; Clean = $Matches[1] + $Matches[2]; Version = $null; Kind = 'screenshot' } }
  if ($hit) { $found += $hit }
}
if (-not $found) { Write-Host "No Access Monitoring Tool files in $Folder. Nothing to do." -ForegroundColor Green; return }

# Keep: per kind of file, the newest version (installers, project zips, versioned checksums), or the newest
# download (manuals, plain SHA256SUMS). Screenshots are all archived.
$keep = @()
foreach ($g in ($found | Where-Object { $_.Kind -ne 'screenshot' } | Group-Object Group)) {
  $best = $g.Group | Sort-Object @{ Expression = { if ($_.Version) { $_.Version } else { [version]'0.0' } } }, @{ Expression = { $_.File.LastWriteTime } } | Select-Object -Last 1
  $keep += $best
}
# A plain "SHA256SUMS (n).txt" is not needed once a versioned SHA256SUMS-x.y.z.txt is kept.
if ($keep | Where-Object { $_.Group -eq 'SHA256SUMS-.txt' }) { $keep = @($keep | Where-Object { $_.Group -ne 'SHA256SUMS.txt' }) }
$keepPaths = $keep | ForEach-Object { $_.File.FullName }
$old = @($found | Where-Object { $keepPaths -notcontains $_.File.FullName -and $_.File.DirectoryName -ne $dest })

$mb = { param($b) '{0:N1} MB' -f ($b / 1MB) }
Write-Host ''
Write-Host "KEEP (moved to $dest):" -ForegroundColor Green
$keep | Sort-Object Clean | ForEach-Object { Write-Host ("  {0,-55} {1,10}" -f $_.Clean, (& $mb $_.File.Length)) }
Write-Host ''
$oldBytes = 0; foreach ($o in $old) { $oldBytes += $o.File.Length }
Write-Host "OLD ($($old.Count) files, $(& $mb $oldBytes)) -> one zip, then deleted only if you agree:" -ForegroundColor Yellow
$old | Sort-Object { $_.File.Name } | ForEach-Object { Write-Host ("  {0,-55} {1,10}" -f $_.File.Name, (& $mb $_.File.Length)) }
if ($ListOnly) { Write-Host "`n-ListOnly: nothing changed." -ForegroundColor Cyan; return }

$go = Read-Host "`nMove the files to keep and put the old ones in a zip? (Y/N)"
if ($go -notmatch '^(y|yes|o|oui)$') { Write-Host 'Nothing changed.'; return }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($k in $keep) {
  $target = Join-Path $dest $k.Clean
  if ($k.File.FullName -ne $target) { Move-Item -LiteralPath $k.File.FullName -Destination $target -Force }
}
Write-Host "Kept files are in $dest" -ForegroundColor Green
if (-not $old) { Write-Host 'No old files.'; return }

# Files already saved in an earlier old-downloads zip (same name and size) are not zipped again, so running the
# script a second time goes straight to the question about deleting them.
$already = @{}
foreach ($z in (Get-ChildItem -LiteralPath $dest -Filter 'old-downloads-*.zip' -File -ErrorAction SilentlyContinue)) {
  $r = [System.IO.Compression.ZipFile]::OpenRead($z.FullName)
  try { foreach ($e in $r.Entries) { $already["$($e.Name)|$($e.Length)"] = $z.Name } } finally { $r.Dispose() }
}
$toZip = @($old | Where-Object { -not $already.ContainsKey("$($_.File.Name)|$($_.File.Length)") })
if ($toZip.Count -lt $old.Count) { Write-Host "$($old.Count - $toZip.Count) old file(s) are already in an earlier zip in $dest." -ForegroundColor Green }
$zipPath = Join-Path $dest ("old-downloads-{0}.zip" -f (Get-Date -Format 'yyyy-MM-dd-HHmm'))
if ($toZip.Count) {
  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
  $names = @{}
  try {
    foreach ($o in $toZip) {
      $entry = $o.File.Name
      if ($names.ContainsKey($entry)) { $entry = "{0}-{1}" -f $o.File.LastWriteTime.ToString('yyyyMMddHHmmss'), $entry }
      $names[$entry] = $o.File.Length
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $o.File.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal)
      Write-Host "  zipped $($o.File.Name)"
    }
  } finally { $zip.Dispose() }

  # Check the zip before anything is deleted: every file there, same size.
  $check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  $bad = @()
  try {
    foreach ($k in $names.Keys) {
      $e = $check.GetEntry($k)
      if (-not $e -or $e.Length -ne $names[$k]) { $bad += $k }
    }
  } finally { $check.Dispose() }
  if ($bad) {
    Write-Host "The zip is not complete ($($bad -join ', ')). Nothing deleted. Zip: $zipPath" -ForegroundColor Red
    return
  }
  $zipSize = (Get-Item -LiteralPath $zipPath).Length
  Write-Host "`nZip checked: $($names.Count) files, $(& $mb $zipSize): $zipPath" -ForegroundColor Green
}

Write-Host "`nThese $($old.Count) old files are now safely in the zip:" -ForegroundColor Yellow
$old | ForEach-Object { Write-Host "  $($_.File.Name)" }
$yes = Read-Host "`nDelete them from Downloads now? Type YES (or Y) and press Enter to delete; anything else keeps them"
if ($yes -and $yes.Trim() -match '^(yes|y|oui|o)$') {   # YES, yes, Y, oui
  $freed = 0
  foreach ($o in $old) { $freed += $o.File.Length; Remove-Item -LiteralPath $o.File.FullName -Force }
  Write-Host "Deleted $($old.Count) files; $(& $mb $freed) freed in Downloads (the zip keeps a copy)." -ForegroundColor Green
} else {
  Write-Host "Kept (you typed '$yes'). The old files are both in Downloads and in the zip; run the script again to delete them." -ForegroundColor Cyan
}
