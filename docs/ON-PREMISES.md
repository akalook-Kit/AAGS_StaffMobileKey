# On-premises installation (Vingcard / Visionline server)

Since release 2.5 the platform can run entirely on a hotel's Visionline server, with no cloud hosting. Since
**2.9 the package is all-in-one**: it carries its own Node.js and PostgreSQL, so nothing has to be installed
on the server first, and the hotel's details are entered in the portal (first-run setup page), not in
PowerShell. This guide is for the hotel's IT partner. The short version for the person at the server is
`README.txt` in the package.

## What runs where

```
                       Visionline server (Windows)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  Visionline ◄── connector (service) ──► platform 127.0.0.1:47300 (service) │
 │                                              │                             │
 │                              database (service, 127.0.0.1 only)            │
 │                                              ▲                             │
 │                                    gateway (service)                       │
 │                         :8443 hotel network     :9443 external entrance    │
 └──────────────────────────────┬──────────────────────┬─────────────────────┘
                                │                      │
                    hotel LAN / Wi-Fi           hotel firewall: public IP:443 → server:9443
                  (portal, staff phones)        only the hotel's own public IP(s)
```

| Part | Windows service | Account | Listens on | Notes |
|---|---|---|---|---|
| Database | `StaffMobileKeyDatabase` | NETWORK SERVICE | 127.0.0.1:5433 only | Bundled PostgreSQL 16; data in `C:\ProgramData\StaffMobileKey\Platform\database` |
| Platform (API, portal, jobs) | `StaffMobileKeyPlatform` | LOCAL SERVICE | 127.0.0.1:47300 only (or the next free port; `-PlatformPort`) | Never reachable from another machine; makes the daily database copy |
| Gateway (HTTPS front door) | `StaffMobileKeyGateway` | LOCAL SERVICE | 8443 (LAN), 9443 (external, optional) | Allow-lists, secret path, security headers, access log |
| Connector | `StaffMobileKeyConnector` | LOCAL SERVICE | 127.0.0.1:8090 (status page) | Talks to Visionline on the same server, outbound to the platform |

All services start with Windows and restart themselves after a failure. No service runs as an administrator.
The service host (`StaffMobileKeyHost.exe`) is compiled on the server from `service\NodeService.cs` by the
installer with the C# compiler that is part of Windows: no third-party wrapper.

### What is in the package (2.9)

| Folder | Content |
|---|---|
| `runtime\node\node.exe` | Node.js 22.23.2, the official Windows build (signed by the OpenJS Foundation) |
| `runtime\pgsql\` | PostgreSQL 16.14 server: `postgres.exe`, `initdb.exe`, `pg_ctl.exe` and their DLLs (EDB Windows binaries, via the embedded-postgres project), plus the Microsoft Visual C++ runtime DLLs they need (signed by Microsoft), placed next to them instead of installed system-wide |
| `runtime\VERSIONS.txt` | Versions, sources and the **SHA-256 of every program file**, for the hotel's antivirus or application allow-list |
| `app\`, `portal\`, `migrations\`, `connector\` | Staff Mobile Key itself |

Every bundled file is pinned and checked when the package is built (`scripts/windows-runtime.mjs`). Nothing is
downloaded on the server, and nothing is installed outside `C:\Program Files\StaffMobileKey` and
`C:\ProgramData\StaffMobileKey`.

## Prerequisites

- Windows Server 2016+ (or Windows 10/11 Pro), 64-bit, administrator rights, about 2 GB free disk.
- .NET Framework 4.8 (part of Windows; used to build the small service host).
- Outbound HTTPS from the server to `hospitality.credential-services.api.assaabloy.com` (ASSA ABLOY Credential
  Services). Nothing inbound from the internet is needed for keys to work.
- For alerts (2.7): outbound to the hotel's mail server (SMTP, usually port 587), and either the Android SMS phone
  on the hotel network or the SMS service's address.

Node.js and PostgreSQL do **not** need to be installed (2.9). A PostgreSQL that is already on the server is
left alone: the bundled database uses its own service, folder and port (5433, or the next free one).

## Installing (any hotel)

1. Unzip `staff-mobile-key-onprem-<version>.zip` on the server.
2. Double-click **`Install.cmd`**. Windows asks for administrator rights; nothing else is asked.
3. At the end the portal opens on the server (`http://127.0.0.1:47300/`) on the **first-run setup** page, with
   the one-time setup code filled in. Enter:
   - the hotel: name, time zone, country, ASSA ABLOY System ID (Visionline: Options → Mobile Access; can be
     left empty), the system number printed on reports, support e-mail and phone for staff;
   - the first administrator: name, e-mail, password (12+ characters);
   - optionally the Credential Services user and password (stored encrypted; can be added later).
4. Sign in. Connector health shows the connector on this server **Online** (it was registered by the
   installer, no token to copy). Enter the Visionline account in Settings → Visionline, run discovery, set the
   branding, and turn on two-step sign-in (Account).

The setup code is shown at the end of the installation and kept in
`C:\ProgramData\StaffMobileKey\Platform\setup-code.txt` (administrators only). It is only accepted until the
hotel and its first administrator exist; then the setup page closes for good. Ten wrong codes in 15 minutes
lock it for 15 minutes. From another PC on the hotel network the setup page is at `https://<server>:8443/`
(type the code).

What the installer does: copies the runtime and the program, creates the database in
`ProgramData\StaffMobileKey\Platform\database` (random superuser and application passwords, stored encrypted
with Windows DPAPI), registers the four services, makes a certificate (server name, `localhost` and the server's
IPv4 addresses), writes the gateway settings, opens the firewall for the hotel network, reads the Visionline
certificate from `https://localhost/api/v1` (see *Certificates*), installs the connector with its token, puts a
"Staff Mobile Key" shortcut on the desktop, and writes a log to `logs\install-<version>-<time>.log`.

`Install.cmd` options (all optional; add them after the name in a command prompt):

| Option | Meaning | Kept on upgrade |
|---|---|---|
| `-ServerName` | Name or IP staff use for the server (default: the computer name); used in the portal address and the certificate | yes |
| `-LanPort 8443` | Port for the hotel network | yes |
| `-PlatformPort 47300` | Internal port of the platform, 127.0.0.1 only. Default 47300 or the next free one. **Port 4000 (the default before 2.11) is often used by PMS interfaces; upgrades move off it automatically** | yes |
| `-ExternalPort 9443 -AllowExternal "..."` | External entrance and the public addresses allowed in (see below) | yes |
| `-RemoveExternal` | Close the external entrance | - |
| `-CertPfx C:\certs\portal.pfx` | A real certificate instead of the self-signed one (asks for its password) | yes |
| `-VisionlineUrl`, `-CaFile` | Visionline on another computer, or its certificate given by hand | connector keeps them |
| `-ReadOnly`, `-NoWatch` | **Only for testing against a Visionline that is not the hotel's own** - `-ReadOnly` stops key issuing | connector keeps them |
| `-SkipConnector` | The connector is installed (or stays) elsewhere | - |
| `-NoBrowser` | Do not open the portal at the end | - |
| `-HotelName -TimeZone -Country [-SystemId -HotelCode -SupportEmail -SupportPhone]` | Scripted installations only: the hotel is created from these instead of the setup page (the first administrator is still made on the setup page) | yes |

**Upgrade:** unzip the new version and double-click its `Install.cmd`. Everything is kept: the hotel, settings,
passwords, ports, allowed addresses, secret path and certificate. A copy of the database is made first.

**Installations from 2.5-2.8** that used a separately installed PostgreSQL are upgraded the same way and keep
using that PostgreSQL; only the program, Node.js runtime and services are updated, and the old scheduled backup
task is replaced by the platform's own daily copy.

## After installing: Visionline data comes by itself (2.10)

Once the connector has the Visionline account (Settings → Visionline), the platform reads the doors, door groups and
user groups, then every Visionline user and their valid keycards, without anyone pressing a button; it repeats this
every 6 hours, and records a keycard encoded at the Visionline desk within seconds. The hotel's own user groups
replace the placeholder names. See **Visionline cards & people** in the portal and [VISIONLINE-DATA.md](VISIONLINE-DATA.md).

## Installer (.msi) and licence (2.12)

`StaffMobileKey-Server-<version>.msi` installs the same package as `Install.cmd` (it runs `install-onprem.ps1` as
SYSTEM) and is the easiest way to hand the platform to a hotel's IT. New installations run as a 60-day trial;
the licence key goes into **Settings → Licence**. Licence checks are switched on by the installer
(`SMK_LICENSING=on`); existing installations start their trial on upgrade, so nothing locks. See
[LICENSING.md](LICENSING.md).

## New in 2.13

Live occupancy and emergency (Safety), staff ID cards (CR80), dark mode, per-person menus and "Visionline only" focus,
the licence window, usage and the signed supplier summary, administrator protection (two-step sign-in required),
privacy retention, the user manual in the portal, and the Visionline limiter in the connector (0.11.0). Upgrade with
the new `.msi` (or `Install.cmd`): data, settings and licence are kept; migration 017 adds the new tables. See
[USER-MANUAL.md](USER-MANUAL.md), [SECURITY-REVIEW-2.13.md](SECURITY-REVIEW-2.13.md) and
[SECURITY-AND-COMPLIANCE.md](SECURITY-AND-COMPLIANCE.md).

For a **fire-warden screen**, create an operator with the role *Safety / fire warden* (Operators → Add operator), sign
in on the PC by the security desk, open *Live occupancy* and press *Full screen*.

## Breakfast (2.11)

Optional module for the restaurant (Settings → Modules → Breakfast): the in-house list is imported from the PMS
"in-house guests" CSV, waiters with the *Restaurant (breakfast)* role record each room, managers print the day sheet.
Nothing extra is installed and no PMS port is used. See [BREAKFAST.md](BREAKFAST.md).

## The public IP is a setting, not part of the program

The allowed public addresses live in `C:\ProgramData\StaffMobileKey\Platform\gateway.config.json` and in the
Windows Firewall rule *Staff Mobile Key - external*. Change them at any time, without reinstalling:

```powershell
cd "C:\Program Files\StaffMobileKey\Platform"
.\set-external-access.ps1 -Show                                          # what is allowed now
.\set-external-access.ps1 -ExternalPort 9443 -AllowExternal "41.202.219.10/32"   # open, or replace the list
.\set-external-access.ps1 -AddAddress 196.201.10.4                       # e.g. the head office
.\set-external-access.ps1 -RemoveAddress 196.201.10.4
.\set-external-access.ps1 -NewSecretPath                                 # if the secret address leaked
.\set-external-access.ps1 -Disable                                       # close the outside entrance
```

The script checks the new settings with the gateway program before using them, keeps the previous file as
`gateway.config.json.bak`, updates the firewall rule and restarts the gateway; if the gateway does not come back
it restores the previous settings. "Every address" (`0.0.0.0/0`) is refused.

## Outside access: public IP + secret pathway

The hotel asked that the platform be reachable from outside only from the hotel's own public address and only
through a special path. The gateway enforces four layers, in this order:

1. **Firewall forwarding.** On the hotel router/firewall forward only `public IP:443 → server:9443`. Windows
   Firewall on the server also allows 9443 only from the `-AllowExternal` addresses.
2. **Address allow-list.** The gateway drops connections from any other address *before* TLS starts, so a
   scanner learns nothing (not even the certificate).
3. **Secret path.** The first request must be `https://<public IP>/<secret path>/`. It sets a signed,
   HttpOnly, SameSite=Strict pass cookie for 12 hours. Every other request without the pass answers
   *Not found*; 20 misses ban the address for 30 minutes. The path (`/k-` + 24 random characters) is printed by
   the installer, kept across upgrades, and stored in `gateway.config.json`.
4. **Sign-in.** Normal portal sign-in, with MFA for administrators.

The external entrance never forwards `/connector/*` or the Credential Services callback path, replaces any
`X-Forwarded-For` sent by the client, and adds HSTS, `X-Frame-Options: DENY`, `nosniff` and a strict
referrer policy. Every request is written to `logs\gateway-access.log` with the secret path masked.

**Staff app.** The app's server address is set when the app is built (`EXPO_PUBLIC_API_URL`). Two workable
set-ups:

- *Hotel Wi-Fi only (simplest):* build with `https://<server name>:8443`. Phones work on the hotel Wi-Fi.
- *Inside and outside:* build with `https://<public name or IP>/<secret path>` — the gateway accepts the path
  as a prefix, so the app needs no cookie. On the hotel Wi-Fi the phone's traffic leaves through the hotel's
  public IP, which is on the allow-list; this needs the router to support "NAT loopback", or a DNS name that
  points to the server inside and to the public IP outside. Away from the hotel the phone must be on an
  allowed network (a VPN, or a mobile network exit address added to `-AllowExternal`).

Keep in mind that the secret path is then inside the app; treat the app build as confidential and change the
path (delete `secretPath` from `gateway.config.json`, rerun the installer, rebuild the app) if a phone is lost
with an unlocked app. A runtime setting for the server address is on the list for the app discussion.

To change the allowed addresses use `set-external-access.ps1` (above).

## Credential Services without inbound callbacks

In the cloud version ASSA ABLOY calls the platform back when a phone is set up or a key changes. On-premises
there is no inbound path, so the platform runs with `CS_CALLBACKS=off` and **asks** instead:

| What | How often |
|---|---|
| Phones waiting to be set up (invitation codes) | every 5 s |
| Keys being issued or revoked | every 10 s |
| Issued keys (removed by a phone deletion or a Visionline override) | each key about every 2 minutes; keys on a deleted phone every 15 s |

The automated checks run the full suite in this mode (350 checks). One thing is not available without callbacks:
the *first use at a door* time (Credential Services READBACK). Lock events from Visionline still arrive through
the connector.

## Certificates

**Portal:** the installer makes a self-signed certificate for `-ServerName`, `localhost` and the server's IPv4
addresses (3 years). Browsers and phones warn until it is trusted: either install the certificate (fingerprint
printed by the installer) on the hotel's PCs and phones, or, better, use a real certificate for a name the hotel
owns (for example `access.khotelbana.com` pointing to the public IP outside and to the server inside) and pass it
with `-CertPfx`.

**Visionline:** when Visionline runs on the same server and the connector has no certificate yet, the installer
reads the certificate Visionline presents on `https://localhost/api/v1` and checks that the connector can verify
it; from then on exactly that certificate is trusted (fingerprint match, verification is never switched off).
This "trust on first use" happens on the server itself, over the loopback address. If Visionline is on another
computer, was not running, or presents a chain the connector cannot verify, the installer says so and the
connector is installed anyway; then use `connector\visionline-probe.ps1 -TlsOnly -SaveCert C:\vl.crt`, confirm
the fingerprint with the Visionline administrator and run `Install.cmd -CaFile C:\vl.crt`
([VISIONLINE-PROBE.md](VISIONLINE-PROBE.md)).

## Passwords and secrets

| Secret | Where it is entered | Where it is kept |
|---|---|---|
| Credential Services user and password | Portal: Settings → Credential Services → *Passwords and keys* (or the setup page) | Database, sealed with AES-256-GCM under a key that is only in `platform.secrets` |
| Mail (SMTP) password, SMS password / API key | Portal: Settings → Alerts & notifications → *Passwords and keys* | as above |
| Visionline account(s) | Portal: Settings → Visionline | Encrypted in the browser for the connector; only the connector can open them |
| Database passwords, session (JWT) and callback keys, the sealing key, the local connector token | Made by the installer | `platform.secrets` / `database.secrets` (Windows DPAPI, this machine) |
| Gateway cookie key, certificate password | Made by the installer (or asked with `-CertPfx`) | `gateway.secrets` (DPAPI) |

A password entered in the portal can be replaced or removed, never read back - not even by an administrator,
and it is never written to the audit trail or the logs (the audit trail records *who* changed *which* one).
A value set with `set-platform-secrets.ps1` (environment of the service) takes precedence and is shown in the
portal as "set in the server's own settings". A database copy alone does not reveal the passwords: the sealing
key is not in the database.

## Files

| Path | Content |
|---|---|
| `C:\Program Files\StaffMobileKey\Platform` | Program (app\*.mjs, portal, migrations, tools) |
| `...\Platform.previous` | The version before the last upgrade (for rollback) |
| `C:\Program Files\StaffMobileKey\Runtime` | Bundled Node.js and PostgreSQL (`VERSIONS.txt`) |
| `C:\ProgramData\StaffMobileKey\Platform\platform.env` | Plain settings |
| `...\platform.secrets`, `...\gateway.secrets`, `...\database.secrets` | DPAPI-encrypted secrets (`database.secrets`: SYSTEM and Administrators only) |
| `...\database\data` | The database (NETWORK SERVICE, SYSTEM, Administrators only); PostgreSQL's own log in `data\log` |
| `...\gateway.config.json` | Listeners, allow-lists, secret path |
| `...\logs\` | platform.log, gateway.log, gateway-access.log, backup.log (rotated, 10 MB × 5), install-*.log |
| `...\backups\` | Database copies (`*.smkbak` + `.sha256`): daily, "Back up now", before upgrades and restores |
| `...\setup-code.txt` | One-time setup code, until the first-run setup is done (administrators only) |

## Backups, upgrade, rollback

- **Database copies (2.9):** made by the platform itself, without PostgreSQL client tools: every day at 02:30
  (server time, the newest 14 kept), on **Settings → Backups → Back up now**, before every upgrade and before a
  restore. A copy is one compressed `.smkbak` file read in a single consistent snapshot while the platform runs,
  with an internal check (row counts and fingerprint) and a `.sha256` file next to it; `database-tools.ps1
  -Action Verify` confirms it is complete and unchanged. **Copy the `backups` folder off the server regularly.**
- **Database tools:** `database-tools.ps1 -Action Size | List | Copy -Destination E:\ | Verify -File ... |
  Optimize | Restore -File ...` (they use the bundled Node.js; see [MONITORING.md](MONITORING.md)). Restore checks
  the copy, saves the current data first, stops the platform, rebuilds the database in one transaction (nothing
  changes if anything fails), applies newer database changes, and starts the platform again.
- **Upgrade:** `Install.cmd` of the new version. It makes a copy first (`smk-*-pre-upgrade.smkbak`), keeps the
  old program in `Platform.previous`, applies new database migrations at start and checks `/healthz` before
  starting the gateway.
- **Rollback:** `rollback-onprem.ps1` (program files) or `rollback-onprem.ps1 -RestoreDatabase` (also the
  database exactly as it was before the upgrade — data entered since is lost; you confirm by typing YES).
- **Uninstall:** `Uninstall.cmd` removes the services, firewall rules, shortcut, certificate and programs and
  keeps `C:\ProgramData\StaffMobileKey` (Install.cmd uses it again); `Uninstall.cmd -RemoveData` deletes it
  too, after confirmation.

## Building the package

```bash
npm run build:portal && npm run package:connector && npm run package:onprem
# -> dist/onprem/staff-mobile-key-onprem-<version>.zip
```

Each program is one bundled file (`platform.mjs`, `gateway.mjs`, `admin.mjs`, `cs-check.mjs`); the server needs
no `npm install`. The packager downloads the pinned Windows runtime once (npm registry and PyPI), checks every
file against the pinned SHA-256/SHA-512 values and caches it in `.cache/windows-runtime`.
