# Putting the project in Git

Run everything in **PowerShell** in the project folder `C:\khb\staff-mobile-key\staff-mobile-key`.
Keep the repository **private**: it contains the K Hotel logo, the hotel's configuration and
development passwords for the simulator.

What is never committed, because `.gitignore` excludes it: your `.env`, `node_modules`, build output
(`dist`), backups and database dumps, probe reports, and `local-test` certificates. `.gitattributes`
keeps PowerShell scripts in Windows line endings and everything else in Linux line endings, so the
scripts and the Docker containers both work.

## Once: install and identify yourself

```powershell
winget install --id Git.Git -e          # or download from https://git-scm.com/download/win; then open a NEW PowerShell
git --version
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global init.defaultBranch main
```

## Once: create the repository and push it

1. On GitHub (or GitLab / Azure DevOps), create a new **private** repository named `staff-mobile-key`,
   **without** a README, .gitignore or licence, so it is empty. Copy its HTTPS address, for example
   `https://github.com/<your-account>/staff-mobile-key.git`.
2. In the project folder:

```powershell
cd C:\khb\staff-mobile-key\staff-mobile-key
git init
git add -A
git status                                # check: no .env, no node_modules, no dist in the list
git commit -m "Access Monitoring Tool platform $(Get-Content VERSION)"
git tag "v$(Get-Content VERSION)"
git remote add origin https://github.com/<your-account>/staff-mobile-key.git
git push -u origin main --tags
```

The first push opens a browser window to sign in. Git Credential Manager, included in Git for Windows,
remembers it.

> With the GitHub CLI (`winget install GitHub.cli`, then `gh auth login`), steps 1–2 can be replaced by:
> `git init; git add -A; git commit -m "Initial import"; gh repo create staff-mobile-key --private --source . --remote origin --push`

## Each new version

`upgrade.ps1` replaces the program files but **keeps `.git`**, so after an upgrade:

```powershell
cd C:\khb\staff-mobile-key\staff-mobile-key
git status                                # what the new version changed
git add -A
git commit -m "Release $(Get-Content VERSION)"
git tag "v$(Get-Content VERSION)"
git push --follow-tags
```

## Your own changes

```powershell
git switch -c my-change                   # work on a branch
# ... edit ...
git add -A
git commit -m "Describe the change"
git push -u origin my-change              # then open a pull request on GitHub
```

Useful: `git log --oneline --decorate -15`, `git diff`, `git restore <file>` (undo an uncommitted edit),
`git switch main`.

## Getting the project on another PC

```powershell
cd C:\khb\staff-mobile-key
git clone https://github.com/<your-account>/staff-mobile-key.git staff-mobile-key
cd staff-mobile-key
Copy-Item .env.example .env               # or copy your own .env across (it is not in Git)
.\scripts\windows\start.ps1
```

Two cautions:
- **Never commit `.env` or real passwords.** If a secret is committed by mistake, change the secret; removing
  it from Git history is not enough.
- The connector package (`dist\connector\…zip`) is a build output. Rebuild it with
  `.\scripts\windows\connector-package.ps1` instead of committing it.

## Updating an old copy to a new release (e.g. 2.17.0) and pushing it

For a PC whose copy has not been updated for a while. The release comes as
`access-monitoring-tool-project-<version>.zip` (the whole project, without `node_modules` or `dist`).

```powershell
cd C:\khb\staff-mobile-key\staff-mobile-key
git status                                   # anything listed was changed on this PC
git stash push -u -m "before 2.17.0"         # only if git status listed changes (get them back: git stash pop)
git fetch origin
git switch main
git pull --ff-only origin main               # this PC now matches GitHub
git switch -c release/2.17.0

# Put the new release over the old files (.git, .env, local-test, node_modules and dist are left alone)
$zip = "$env:USERPROFILE\Downloads\access-monitoring-tool-project-2.17.0.zip"
$tmp = Join-Path $env:TEMP 'amt-2.17.0'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $tmp
robocopy "$tmp\access-monitoring-tool-project-2.17.0" . /MIR /XD .git node_modules dist local-test backups /XF .env /NFL /NDL /NJH /NP
if ($LASTEXITCODE -ge 8) { Write-Host 'robocopy failed' -ForegroundColor Red } else { Write-Host 'Files updated' -ForegroundColor Green }

git status                                   # check: no .env, no node_modules, no dist
git add -A
git commit -m "Release 2.17.0: Access Monitoring Tool"
git push -u origin release/2.17.0
git switch main
git merge --ff-only release/2.17.0
git push origin main
git tag v2.17.0
git push origin v2.17.0
```

Optional check before pushing (needs Node.js 22): `npm ci` then `npm run typecheck`.

## Catching up several releases at once (2.20)

When several releases were not pushed, `scripts\git-catch-up.ps1` (also in the project zip) commits each one in order,
with a tag per version (`v2.17.0`, `v2.17.1`, … `v2.24.0`), and pushes. Versions already tagged are skipped.

```powershell
# 1. Put the project zips (access-monitoring-tool-project-<version>.zip) in Downloads.
# 2. Get the script from the newest zip and run it:
Expand-Archive "$env:USERPROFILE\Downloads\access-monitoring-tool-project-2.24.0.zip" "$env:TEMP\amt-2.24.0" -Force
powershell -ExecutionPolicy Bypass -File "$env:TEMP\amt-2.24.0\access-monitoring-tool-project-2.24.0\scripts\git-catch-up.ps1" `
  -Repo C:\khb\staff-mobile-key\staff-mobile-key -From "$env:USERPROFILE\Downloads"
```

Only the newest zip is strictly needed: each zip holds the whole project, so pushing 2.24.0 alone also brings every
earlier change (as one commit instead of one per version).

## Catching up 2.25 → 2.28 (5 Nov 2026)

Download the project zips you have not pushed yet (for example `access-monitoring-tool-project-2.25.0.zip` …
`access-monitoring-tool-project-2.28.0.zip`) into **Downloads**, then in PowerShell:

```powershell
$v = '2.28.0'
Expand-Archive "$env:USERPROFILE\Downloads\access-monitoring-tool-project-$v.zip" "$env:TEMP\amt-$v" -Force
powershell -ExecutionPolicy Bypass -File "$env:TEMP\amt-$v\access-monitoring-tool-project-$v\scripts\git-catch-up.ps1" `
  -Repo C:\khb\staff-mobile-key\staff-mobile-key -From "$env:USERPROFILE\Downloads"
cd C:\khb\staff-mobile-key\staff-mobile-key
git log --oneline --decorate -8        # one commit and one tag per version
git tag --list "v2.2*"
```

Only the newest zip is needed if the older ones are no longer at hand (each zip is the whole project).

## 2.34.0 (11 Nov 2026): the Light version beside the standard one

Both installers come from the same project and the same commit, so one repository and one release hold them:
`AccessMonitoringTool-Server-2.34.0.msi` (standard) and `AccessMonitoringTool-Light-2.34.0.msi` (lock diagnosis
only). Download `access-monitoring-tool-project-2.34.0.zip` into **Downloads**, then

```powershell
$v = '2.34.0'
Expand-Archive "$env:USERPROFILE\Downloads\access-monitoring-tool-project-$v.zip" "$env:TEMP\amt-$v" -Force
powershell -ExecutionPolicy Bypass -File "$env:TEMP\amt-$v\access-monitoring-tool-project-$v\scripts\git-catch-up.ps1" `
  -Repo C:\khb\staff-mobile-key\staff-mobile-key -From "$env:USERPROFILE\Downloads"
cd C:\khb\staff-mobile-key\staff-mobile-key
git log --oneline --decorate -3        # origin/main must be on v2.34.0
```

Release on the website: https://github.com/akalook-Kit/AAGS_StaffMobileKey/releases/new → *Choose a tag* `v2.34.0`
→ title `2.34.0 (Light version: lock diagnosis and day reports)` → drag **both** .msi files and
`SHA256SUMS-2.34.0.txt` → **Publish release**.

To build either installer yourself from the project: `npm run package:onprem && npm run package:msi` (standard), or
`$env:SMK_PACKAGE_EDITION='light'; npm run package:onprem; npm run package:msi` (Light).

## 2.33.1 (10 Nov 2026)

Same as 2.33.0 with `$v = '2.33.1'`: download `access-monitoring-tool-project-2.33.1.zip` into **Downloads**, then

```powershell
$v = '2.33.1'
Expand-Archive "$env:USERPROFILE\Downloads\access-monitoring-tool-project-$v.zip" "$env:TEMP\amt-$v" -Force
powershell -ExecutionPolicy Bypass -File "$env:TEMP\amt-$v\access-monitoring-tool-project-$v\scripts\git-catch-up.ps1" `
  -Repo C:\khb\staff-mobile-key\staff-mobile-key -From "$env:USERPROFILE\Downloads"
cd C:\khb\staff-mobile-key\staff-mobile-key
git log --oneline --decorate -3        # origin/main must be on v2.33.1
```

The installers are attached to a GitHub **release** on the website (no tool to install): open
https://github.com/akalook-Kit/AAGS_StaffMobileKey/releases/new → *Choose a tag* `v2.33.1` → title
`2.33.1 (La Falaise light edition, French)` → drag the two .msi files and `SHA256SUMS-2.33.1.txt` → wait for the
uploads → **Publish release**. (`gh release create …` does the same once the GitHub CLI is installed:
`winget install --id GitHub.cli -e`, then `gh auth login`.)

## 2.29 → 2.33 and the La Falaise light edition (10 Nov 2026)

The La Falaise light edition is **not a separate project**: it is the same code, version 2.33.0, built with one
setting (`SMK_PACKAGE_EDITION=la-falaise-light`). One push to GitHub brings both. Download
`access-monitoring-tool-project-2.33.0.zip` into **Downloads** (plus 2.30.0 … 2.32.0 if you want one commit per
version), then in PowerShell:

```powershell
$v = '2.33.0'
Expand-Archive "$env:USERPROFILE\Downloads\access-monitoring-tool-project-$v.zip" "$env:TEMP\amt-$v" -Force
powershell -ExecutionPolicy Bypass -File "$env:TEMP\amt-$v\access-monitoring-tool-project-$v\scripts\git-catch-up.ps1" `
  -Repo C:\khb\staff-mobile-key\staff-mobile-key -From "$env:USERPROFILE\Downloads"
cd C:\khb\staff-mobile-key\staff-mobile-key
git log --oneline --decorate -6        # origin/main must be on v2.33.0
```

The .msi files are not put in Git (they are built). To keep them on GitHub, attach them to a release:
GitHub → the repository → **Releases** → **Draft a new release** → tag `v2.33.0` → drag
`AccessMonitoringTool-Server-2.33.0.msi`, `AccessMonitoringTool-LaFalaise-Light-2.33.0.msi` and
`SHA256SUMS-2.33.0.txt` → **Publish release**. With the GitHub CLI instead:

```powershell
gh release create v2.33.0 "$env:USERPROFILE\Downloads\AccessMonitoringTool-Server-2.33.0.msi" `
  "$env:USERPROFILE\Downloads\AccessMonitoringTool-LaFalaise-Light-2.33.0.msi" "$env:USERPROFILE\Downloads\SHA256SUMS-2.33.0.txt" `
  --repo akalook-Kit/AAGS_StaffMobileKey --title "2.33.0 (with La Falaise light edition)" --notes "See docs/QUICK-START.md"
```

Building the light .msi from the code (Linux/WSL with wixl): 

```bash
npm ci && npm run build:portal && npm run package:connector
SMK_PACKAGE_EDITION=la-falaise-light npm run package:onprem && npm run package:msi
# -> dist/msi/AccessMonitoringTool-LaFalaise-Light-<version>.msi
```

### When the push fails ("RPC failed; HTTP 408", "curl 55 … Connection was aborted", "Could not resolve host")

The internet connection was cut or too slow: nothing was lost, the commits and tags are on the PC. From 2.29 the
script tries three times and says **NOT pushed** in red if it still fails (2.28 wrongly said "Pushed"). Check with
`git status` ("Your branch is ahead of 'origin/main' by N commits"), then push when the line is better:

```powershell
cd C:\khb\staff-mobile-key\staff-mobile-key
git config http.postBuffer 524288000
git push origin main --follow-tags
git push origin --tags
git log --oneline --decorate -4          # origin/main must now be on the newest release
```
