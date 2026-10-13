# Deploying the K Hotel staff key platform on your Windows PC

This guide installs the test environment on a Windows PC **that already runs other applications**,
without changing or clashing with them. Everything runs inside Docker containers with their own
names, network, storage and uncommon ports. The hotel's Visionline system is replaced by a built-in
simulator, so nothing here talks to a real lock.

Time needed: about 30 minutes the first time (mostly downloads), 1 minute afterwards.

---

## What this adds to your PC — and what it never touches

| Item | Name / value | Notes |
|---|---|---|
| Docker containers | `khb-staffkey-db-1`, `khb-staffkey-simulator-1`, `khb-staffkey-backend-1`, `khb-staffkey-connector-1` | All prefixed `khb-staffkey` |
| Docker image | `khb-staffkey:dev` (plus the public `postgres:16` image) | |
| Docker volumes (data) | `khb-staffkey_pgdata`, `khb-staffkey_certs`, `khb-staffkey_connector-data` | Removed only by `stop.ps1 -Purge` |
| Docker network | `khb-staffkey-net` | Separate from your other containers' networks |
| Ports on your PC | **14080** portal, **14444** lock simulator, **14090** connector page (+ **14081** only while testing on a phone) | Bound to `127.0.0.1` = reachable from this PC only |
| Memory / CPU caps | database 512 MB, backend 512 MB, simulator 256 MB, connector 256 MB; 3 CPUs in total | Your other apps keep their resources |

**Not used:** ports 80, 443, 3000, 4000, 5000, 5432, 8000, 8080, 8443; the database is not exposed to
your PC at all, so an existing PostgreSQL on 5432 is unaffected. No Windows services, no registry or
PATH changes, no global npm packages. Containers do **not** start automatically with Windows unless
you choose to (see `SMK_RESTART` in `.env`).

---

## Step 1 — Check your PC

- Windows 10 (22H2) or Windows 11, 64-bit.
- At least 8 GB RAM (16 GB is comfortable if you run other apps) and 10 GB free disk.
- Hardware virtualisation enabled. Check: Task Manager → Performance → CPU → *Virtualization: Enabled*.
  If it says Disabled, enable *Intel VT-x* / *AMD-V* (SVM) in the BIOS.

## Step 2 — Docker Desktop

**Already have Docker Desktop?** Skip to Step 3. Your existing containers are not affected:
this project uses its own names, network and ports.

Otherwise:
1. Download Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/
2. Run the installer with the default **Use WSL 2** option. Restart Windows when asked.
3. Start **Docker Desktop** from the Start menu and wait until the bottom-left says **Engine running**.
4. In Docker Desktop → Settings → General, you can untick *Start Docker Desktop when you sign in*
   if you only want it running while you test.

Check in **PowerShell** (Start menu → type *PowerShell*):

```powershell
docker --version
docker compose version
```

## Step 3 — Node.js (only for testing the app on a phone)

Skip this step if you will only use the web portal.

```powershell
node --version
```

- **Shows v20.19 or newer (e.g. v22.x)?** You're done; nothing to install.
- **Shows an older version that your other apps need?** Don't replace it. Install
  **nvm-windows** (https://github.com/coreybutler/nvm-windows/releases), then `nvm install 22` and
  switch with `nvm use 22` only while testing this project; `nvm use <old version>` switches back.
- **Not installed?** Install Node.js 22 LTS from https://nodejs.org (accept defaults).

## Step 4 — Unzip the project

Unzip `staff-mobile-key.zip` into `C:\khb\staff-mobile-key`. The zip contains a folder of the same
name, so the project ends up in:

```
C:\khb\staff-mobile-key\staff-mobile-key
```

This guide calls that the **project folder**: it contains `docker-compose.yml`, `.env.example` and
`scripts\windows`. Every command below is run from it. Avoid OneDrive/Dropbox-synced folders.

**Already installed an earlier version?** Follow [UPGRADING.md](UPGRADING.md) instead.

## Step 5 — Allow the helper scripts in this window

Windows blocks downloaded scripts by default. Open **PowerShell** in the project folder and run:

```powershell
cd C:\khb\staff-mobile-key\staff-mobile-key
Get-ChildItem -Recurse -Filter *.ps1 | Unblock-File
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

The second line applies **only to this PowerShell window** and resets when you close it. Repeat it
each time you open a new window to run the scripts.

## Step 6 — Pre-flight check (changes nothing)

```powershell
.\scripts\windows\check.ps1
```

It creates `.env` from `.env.example` the first time, then checks that Docker is running, that ports
14080, 14444, 14090 and 14081 are free, and that there is enough disk space.

**If a port shows BUSY**, open `.env` in Notepad and change that number, e.g.
`SMK_PORTAL_PORT=15080`. Any free number between 1025 and 49151 works. Run `check.ps1` again.

## Step 7 — Start

```powershell
.\scripts\windows\start.ps1
```

The first run builds the image (5–10 minutes). When it prints **Ready.** the portal opens in your browser.

| Open | Sign in with |
|---|---|
| Portal — http://localhost:14080 | `admin@khb.test` / `ChangeMe!2026` (Hotel Administrator) |
| | `issuer@khb.test` (Key Issuer), `security@khb.test` (Security Manager), `auditor@khb.test` (Auditor) — same password |
| Lock simulator — http://localhost:14444 | — (shows door openings, credentials, and switches to simulate failures) |
| Connector page — http://localhost:14090 | user `admin`, password `local-admin` |

## Step 8 — Try it

1. As **admin@khb.test**: **Connector health** → **Run resource discovery**. The readiness checklist turns green.
2. Phones must be set up before keys can be issued. Either run the automated checks (Step 9),
   which set up three test phones, or use a real phone (Step 10).
3. As **issuer@khb.test**: **Mobile keys** → **Issue a key** → pick a person, template *Floor 1 rooms*, *8 h* → **Issue key**.
   Watch it go from *Waiting for hotel connector* to *Active*.
4. Request *All guest rooms (broad)*: it waits for approval. Approve it as **security@khb.test**.
5. Open a key → **Revoke key**. The lock simulator page shows the door now refusing it.
6. As **auditor@khb.test**: **Audit trail** → **Check integrity** and **Export CSV**.
7. Simulate problems on the lock simulator page: tick *Visionline outage*, or arm *Fail next card* with
   `40308`, then issue a key and read the explanation in the portal.

The K Hotel branding (black and rose gold, your logo) is set in **Mobile app settings**. A logo
uploaded there replaces it in the portal and the app immediately.

### New in 2.4 — Phase 2: battery status and maintenance

Switch the modules on first: as **admin@khb.test**, **Settings → Modules** → tick *Battery monitoring* and
*Maintenance requests* → **Save**. **Battery status** and **Maintenance** then appear in the menu. New test
accounts: **maint@khb.test** (Maintenance Manager) and **tech@khb.test** (Technician), same password.

| Feature | Where | What to check |
|---|---|---|
| Battery alarms | Lock simulator → **Lock batteries** → *Low* / *Critical* / *Exchanged* next to a door | Within seconds the door changes colour on **Battery status**. A critical alarm opens a maintenance request automatically. *Exchanged* resolves the alert and its request. |
| Duplicate alarms | Press *Low* twice for the same door | One alert with "2 reports"; the maintenance team is told once. |
| Acknowledge / resolve | **Battery status** → a door | As **maint@khb.test**: *Acknowledge*, *Open maintenance request*, *Mark resolved* (battery replaced). |
| Thresholds and staleness | **Settings → Battery & maintenance** | Voltage thresholds for "below X volts" events, days until a reading is stale, automatic requests, due times, which job roles are told. |
| Maintenance requests | **Maintenance** → **New request** | Assign to **Peter Otieno**; set priority; comment; attach a photo; resolve; close; export CSV. |
| Tasks in the staff app | Phone, signed in as **peter@khb.test** | New **Tasks** tab: acknowledge, start, put on hold, mark done (a note is required). Any staff member can **Report a problem**. |

### New in 2.3 — K Hotel Bana account, reg. no.

| Change | Where |
|---|---|
| The key's **reg. no.** is now the Visionline card registration number, looked up after the key is created; the **credential ID** is shown separately | Key detail; lock simulator shows both |
| K Hotel Bana's Mobile Access account (`hma-cs-…`, System ID 3460) is configured; the simulator mirrors it | Settings → Visionline / Credential Services, Connector health readiness |
| Read-only check of the real Credential Services user and password | `.\scripts\windows\cs-check.ps1 -User k_-_hotel_bana-lhtgdm7qp6jsbsm -SystemId 3460`, see [K-HOTEL-BANA.md](K-HOTEL-BANA.md) |

### New in 2.2 — Visionline watch and the Windows connector

| Feature | Where | What to check |
|---|---|---|
| Card cancelled in Visionline | Lock simulator → **Cancel in Visionline** next to a key's reg. no. | Within seconds the key shows *Revoked · Card cancelled in Visionline*, and the staff app shows it as cancelled. |
| Wrong-door limit | Open doors that are not on a key (lock simulator, or the app's door picker) | Each refusal is listed under *Reported by Visionline* on the key. The 6th cancels the card automatically. Limit: **Settings → Key policy**. |
| Reg. no. | Key detail, staff app key card | The Visionline card number of each key. *Change doors* gives a new one. |
| Revoke by cancelling the card | Key → **Revoke key** → *Cancel card in Visionline* | For a lost phone; the normal choice is *Check out*. |
| Start and end time | Issue a key → Starts *Later* + *End date…* | Held by the platform until the start (default), or sent to Visionline (**Settings → Visionline → Keys that start later**). |
| Time schedules | **Settings → Access templates** | Pick a Visionline time schedule per template. |
| Windows-service connector | [CONNECTOR-LOCAL-TEST.md](CONNECTOR-LOCAL-TEST.md) | Install the real connector service on your PC and switch with `start.ps1 -NativeConnector`. |

### New in 2.0 — try these too

| Feature | Where | What to check |
|---|---|---|
| Property Visionline credentials | **Settings → Visionline → Change property credentials** | Enter `sym` / `sym-dev-password` → **Test and save**. The connector tests them with Visionline first; *Property credentials* then shows `sym`. A wrong password is refused and the old credentials stay in use. |
| Your own Visionline credentials | Your name (bottom-left) → **Visionline credentials** | Enter `eric` / `eric-dev-password` → **Save and verify**. Keys you issue are then created in Visionline under `eric` (key detail: *Created in Visionline by*). Other simulator operators: `sandra` / `sandra-dev-password`. |
| Mobile Access UUID and revoke mode | **Settings → Visionline → Mobile Access** | Pre-set to UUID **9** and *When overridden*, matching Visionline Options at K Hotel. |
| Several user groups | **Settings → Visionline → Staff user groups** | Housekeeping, Maintenance, Security (uniform access), Management, Front Office. Add one and click **Add and create in Visionline**. Give staff a group in **Staff → Manage**. |
| Templates with user groups | **Settings → Access templates** | Open *Maintenance rounds*: it combines Floor 1 with the Maintenance group's doors. |
| Change doors | **Mobile keys** → open an active key → **Change doors** | The new key replaces the old one through Visionline *override*; the old key leaves the phone. |
| Uniform-access staff | Issue a key to **Brice Ngono** (Security) | The doors come from the Security group in Visionline and can't be changed. |
| Import staff | **Staff → Import from file** | Use **Download a template**, fill it in Excel, save as *CSV UTF-8*, drop it in. *Check file* previews before anything is saved. Names written *Last, First* are recognised. |
| Building addresses | **Settings → Building addresses** | Shown in the app under the key, with a map link. |
| Staff app | Phone (Step 10) | New key-card design, tap button with feedback, doors by floor, **English / Français** under *Profile → Language* (the app follows the phone's language at first). |

## Step 9 — Automated acceptance checks (optional)

Runs inside the container, so Node.js is not needed:

```powershell
.\scripts\windows\test.ps1 -Fast    # about 1 minute
.\scripts\windows\test.ps1          # full run including the 2-minute expiry check
```

It should end with `154 passed, 0 failed` (`151 passed` with `-Fast`).

## Step 10 — Test the staff app on your phone (optional)

Your phone and PC must be on the **same Wi-Fi**, and that network must be set to **Private** in
Windows (Settings → Network & internet → Wi-Fi → your network → *Private network*).

1. Restart with phone access (the portal and simulator become reachable from your Wi-Fi; the connector page stays local):
   ```powershell
   .\scripts\windows\start.ps1 -Phone
   ```
2. Allow the three test ports through Windows Firewall, **once**, from a PowerShell opened with
   *Run as administrator* (private networks only):
   ```powershell
   cd C:\khb\staff-mobile-key\staff-mobile-key
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\scripts\windows\phone.ps1 -AddFirewallRule
   ```
3. Back in your normal PowerShell window:
   ```powershell
   .\scripts\windows\phone.ps1
   ```
   It finds your PC's Wi-Fi address (or pass `-Ip 192.168.1.20`), installs the app's packages the
   first time, and shows a QR code.
4. On the phone, install **Expo Go** (Play Store / App Store), then scan the QR code (Android: in Expo Go;
   iPhone: with the Camera app).
5. Sign in as `amina@khb.test` / `Staff!2026` → **Set up this phone**. Issue Amina a key in the portal,
   then tap **Hold your phone near the lock** and choose a door (the simulator stands in for Bluetooth).

When you finish phone testing:

```powershell
.\scripts\windows\start.ps1 -Local                 # back to this-PC-only
.\scripts\windows\phone.ps1 -RemoveFirewallRule    # in an Administrator PowerShell
```

> Expo Go runs one SDK version at a time; this app uses **Expo SDK 57**. If Expo Go says the project
> is incompatible, update Expo Go from the store.

## Upgrading an existing installation

New versions install themselves and keep a backup you can go back to; your test data is kept.
Follow **[UPGRADING.md](UPGRADING.md)**. In short, with the new zip in Downloads, paste in PowerShell:

```powershell
$zip = "$env:USERPROFILE\Downloads\staff-mobile-key.zip"
$new = "C:\khb\_new"
Remove-Item $new -Recurse -Force -ErrorAction SilentlyContinue
Unblock-File $zip
Expand-Archive $zip -DestinationPath $new
powershell -ExecutionPolicy Bypass -File "$new\staff-mobile-key\scripts\windows\upgrade.ps1"
```

Go back to the previous version with `.\scripts\windows\rollback.ps1 -Latest`.

## Checking the real Visionline server (read-only)

Before connecting the platform to the real Visionline, run the probe. It changes nothing in Visionline:
see [VISIONLINE-PROBE.md](VISIONLINE-PROBE.md).

```powershell
.\scripts\windows\visionline-probe.ps1 -TlsOnly
.\scripts\windows\visionline-probe.ps1 -User sym -CaFile C:\khb\visionline-ca.crt
```

## Everyday commands

| Task | Command |
|---|---|
| Start | `.\scripts\windows\start.ps1` |
| What's running, and the links | `.\scripts\windows\status.ps1` |
| Stop (keeps data) | `.\scripts\windows\stop.ps1` |
| Remove containers, keep data | `.\scripts\windows\stop.ps1 -Remove` |
| Fresh start (deletes test data) | `.\scripts\windows\stop.ps1 -Purge`, then `start.ps1` |
| Logs | `docker compose logs -f backend connector simulator` |
| Read-only Visionline check | `.\scripts\windows\visionline-probe.ps1` |
| Version installed | `.\scripts\windows\status.ps1` (first line) |
| Install a newer version | see [UPGRADING.md](UPGRADING.md) (`upgrade.ps1`, run from the new zip) |
| Go back to the previous version | `.\scripts\windows\rollback.ps1 -Latest` |

## Removing everything

```powershell
.\scripts\windows\stop.ps1 -Purge                  # containers, volumes, network, project image
.\scripts\windows\phone.ps1 -RemoveFirewallRule    # only if you added it (Administrator PowerShell)
```

Then delete the `C:\khb\staff-mobile-key` folder. Optionally remove the shared `postgres:16` image
with `docker image rm postgres:16` if no other project uses it.

## Troubleshooting

| What you see | What to do |
|---|---|
| *running scripts is disabled on this system* | Run Step 5 again in this window. |
| *Docker Desktop is not running* | Start Docker Desktop and wait for *Engine running*. |
| A port is BUSY | Change it in `.env`, then `start.ps1`. |
| *The portal did not answer yet* | Wait a minute and open the link; or `docker compose logs backend`. |
| Readiness shows *Credential Services callbacks* not ready | Wait one minute; the backend retries every minute. |
| Phone can't connect | Open `http://<PC-IP>:14080/healthz` in the phone's browser. If it fails: check same Wi-Fi, network set to *Private*, the firewall rule, and that you started with `-Phone`. |
| PC feels slow | `stop.ps1` when not testing. The containers are capped at about 1.3 GB RAM in total. |
| Something odd after many tests | `stop.ps1 -Purge`, then `start.ps1` for a clean start. |

## Replacing the logo with the high-resolution version

- **Portal and app screens:** sign in as admin → **Mobile app settings** → *Logo* → choose the PNG
  (up to 500 KB) → **Publish changes**.
- **Phone home-screen icon and splash** (needed before a store release): replace `icon.png` (1024×1024),
  `adaptive-icon.png` and `splash.png` in `apps\mobile\tenants\k-hotel-bana\`. The current ones were made
  from the small 257×90 logo and are interim.
