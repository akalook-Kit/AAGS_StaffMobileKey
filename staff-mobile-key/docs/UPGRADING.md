# Installing a newer version (and going back)

Each new version comes as `staff-mobile-key.zip`. You don't unzip it over your installation. The new
version installs itself with `upgrade.ps1`, which:

1. **saves the installed version** to `C:\khb\backups\staff-mobile-key-<old version>-<date-time>`:
   the program files with your `.env`, plus the test data (database, connector keys, simulator
   certificates);
2. stops the containers and **replaces the program files**. It keeps your `.env` (adding any new
   settings with their defaults), the Visionline probe reports and the installed phone-app packages;
3. **starts the new version**. The database updates itself, and the portal opens when it is ready.

If anything goes wrong, `rollback.ps1` puts the saved version back, files and data.

Your installation: `C:\khb\staff-mobile-key\staff-mobile-key` (the *project folder*).

## Upgrade: copy and paste this

1. Download the new `staff-mobile-key.zip` to your **Downloads** folder.
2. Make sure Docker Desktop is running (*Engine running*).
3. Open **PowerShell** (no need for Administrator) and paste the whole block:

```powershell
$zip = "$env:USERPROFILE\Downloads\staff-mobile-key.zip"
$new = "C:\khb\_new"
Remove-Item $new -Recurse -Force -ErrorAction SilentlyContinue
Unblock-File $zip
Expand-Archive $zip -DestinationPath $new
powershell -ExecutionPolicy Bypass -File "$new\staff-mobile-key\scripts\windows\upgrade.ps1"
```

If your browser saved the file under another name (for example `staff-mobile-key (1).zip`),
change the first line to match it.

It takes a few minutes, because the new version is rebuilt. It ends with:

```
Upgrade to <new version> finished. Backup of <old version>: C:\khb\backups\staff-mobile-key-...
If something is wrong, go back with:
  powershell -ExecutionPolicy Bypass -File "...\rollback.ps1" -Backup "C:\khb\backups\..."
```

4. Check the result: run `.\scripts\windows\status.ps1` in the project folder. It shows the version.
   Then sign in to the portal as usual.
5. Clean up the temporary copy: `Remove-Item C:\khb\_new -Recurse -Force`

**Options** (add them to the end of the last line):

| Option | Use |
|---|---|
| `-Target D:\other\folder` | Your installation is somewhere else. |
| `-BackupRoot D:\backups` | Keep backups somewhere else. |
| `-SkipDataBackup` | Back up program files only (faster; rollback then keeps the current data). |
| `-NoStart` | Replace the files but don't start; start later with `start.ps1`. |

If the upgrade stops with a red message *before* "Installing version …", nothing was changed. If it
stops later, it prints the rollback command.

## The connector installed as a Windows service

`upgrade.ps1` updates the test environment, including the built-in connector container. A connector
installed as a Windows service, on your PC or on the Visionline PC, is upgraded separately: unzip the new
`staff-mobile-key-connector-<version>.zip` and run `.\install.ps1` in it as administrator. Settings and
secrets are kept. See [CONNECTOR-WINDOWS-SERVICE.md](CONNECTOR-WINDOWS-SERVICE.md).

## Going back to the previous version

From the project folder, or from anywhere:

```powershell
powershell -ExecutionPolicy Bypass -File C:\khb\staff-mobile-key\staff-mobile-key\scripts\windows\rollback.ps1 -Latest
```

It asks you to type **YES**. Then it restores the program files and `.env` from the most recent backup,
puts the **data back as it was just before the upgrade**, and starts that version. Keys, staff or
settings changed after the upgrade are lost.

- A specific backup: `-Backup C:\khb\backups\staff-mobile-key-2.1.0-20261020-0930`
- Program files only, keeping today's data: add `-FilesOnly`. This works because database updates so far
  only add tables and columns, so an older version still runs on newer data. If it doesn't start, run without `-FilesOnly`.

## Backups

- Each upgrade makes one folder in `C:\khb\backups`, usually a few MB. `backup-info.txt` inside says
  which version it holds and the exact rollback command.
- Delete old backup folders whenever you like. Keep at least the latest one until you are happy with the
  new version.
- Backups contain the test database and the connector's encrypted key store, so keep them on this PC.

## The first time (version 2.0, installed before these scripts existed)

The block above works for 2.0 too. The upgrade script comes with the *new* version, so the old one
doesn't need it. The backup folder is then named `staff-mobile-key-2.0-…`.

## Without the scripts (manual)

1. In the project folder: `.\scripts\windows\stop.ps1`.
2. Copy the whole project folder to a backup location, leaving out any `node_modules` folders.
3. Delete everything in the project folder except `.env`, then unzip the new version's
   `staff-mobile-key` folder contents into it.
4. `.\scripts\windows\start.ps1`.

This manual route doesn't save the database. For that, use the scripts.
