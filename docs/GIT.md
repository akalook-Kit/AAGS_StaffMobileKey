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
git commit -m "Staff Mobile Key platform $(Get-Content VERSION)"
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
