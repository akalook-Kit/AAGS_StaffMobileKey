<#
  Access Monitoring Tool - put every release you have not pushed yet into Git, one commit and one tag per version,
  then push. Run in PowerShell (not as administrator) on the PC with your Git copy.

    1. Download the project zips (access-monitoring-tool-project-<version>.zip) into one folder, e.g. Downloads.
    2. .\git-catch-up.ps1                       (defaults below)
       .\git-catch-up.ps1 -Repo D:\code\staff-mobile-key -From D:\zips -NoPush

  Versions already tagged in Git (v2.17.0, ...) are skipped, so it is safe to run again. Each zip is the whole project:
  files that are not in it are removed from the copy (except .git, .env, node_modules, dist, local-test, backups), so
  keep anything you added by hand somewhere else first. Local changes are put aside with "git stash" first.
#>
param(
  [string]$Repo = 'C:\khb\staff-mobile-key\staff-mobile-key',
  [string]$From = (Join-Path $env:USERPROFILE 'Downloads'),
  [string]$Branch = 'main',
  [switch]$NoPush
)
$ErrorActionPreference = 'Stop'
function Run([string]$what) { Write-Host "> $what" -ForegroundColor DarkGray }
Set-Location $Repo
git rev-parse --is-inside-work-tree | Out-Null
if (git status --porcelain) { Run 'git stash'; git stash push -u -m "before catch-up $(Get-Date -Format s)" | Out-Null; Write-Host 'Your local changes were put aside (git stash list; get them back with git stash pop).' -ForegroundColor Yellow }
Run "git fetch / switch $Branch / pull"
git fetch origin
git switch $Branch
git pull --ff-only origin $Branch

$zips = Get-ChildItem $From -Filter '*-project-*.zip' | ForEach-Object {
  if ($_.Name -match '-project-(\d+\.\d+\.\d+)\.zip$') { [pscustomobject]@{ V = [version]$Matches[1]; File = $_.FullName } }
} | Sort-Object V
if (-not $zips) { throw "No project zips (…-project-<version>.zip) found in $From." }

$done = 0
foreach ($z in $zips) {
  $tag = "v$($z.V)"
  if (git tag --list $tag) { Write-Host "$tag is already in Git: skipped"; continue }
  $tmp = Join-Path $env:TEMP "amt-catch-up-$($z.V)"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $z.File -DestinationPath $tmp
  $src = @(Get-ChildItem $tmp -Directory)[0].FullName
  & robocopy $src . /MIR /XD .git node_modules dist local-test backups /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $($z.V) failed (robocopy code $LASTEXITCODE)." }
  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { git commit -q -m "Release $($z.V): Access Monitoring Tool" } else { Write-Host "$($z.V): no change compared with the previous version" }
  git tag $tag
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "$tag committed" -ForegroundColor Green
  $done++
}
# 2.29 Push for real: count what GitHub does not have yet (also commits from an earlier run whose push failed),
# retry a slow or cut connection, and only say "pushed" when Git says so.
$ahead = 0; try { $ahead = [int](git rev-list --count "origin/$Branch..$Branch" 2>$null) } catch { $ahead = $done }
if ($NoPush) {
  if ($ahead) { Write-Host "Committed; $ahead commit(s) not pushed (-NoPush). Push later with: git push origin $Branch --follow-tags" }
  else { Write-Host 'Nothing new to commit.' }
} elseif ($ahead -eq 0 -and -not $done) {
  Write-Host 'Nothing new: GitHub already has everything.' -ForegroundColor Green
} else {
  git config http.postBuffer 524288000 | Out-Null       # large pushes on a slow line
  $ok = $false
  foreach ($try in 1..3) {
    Run "git push origin $Branch --follow-tags (try $try of 3)"
    git push origin $Branch --follow-tags
    if ($LASTEXITCODE -eq 0) { git push origin --tags; if ($LASTEXITCODE -eq 0) { $ok = $true; break } }
    Write-Host 'The push did not go through (network). Trying again in 20 seconds...' -ForegroundColor Yellow
    Start-Sleep -Seconds 20
  }
  if ($ok) { Write-Host "Pushed to GitHub ($ahead commit(s))." -ForegroundColor Green }
  else {
    Write-Host 'NOT pushed: GitHub could not be reached or the connection was cut. Your commits are safe on this PC.' -ForegroundColor Red
    Write-Host "When the internet is better, run:  git push origin $Branch --follow-tags ; git push origin --tags" -ForegroundColor Red
  }
}
git log --oneline -n ([Math]::Max($done, 1) + 1)
