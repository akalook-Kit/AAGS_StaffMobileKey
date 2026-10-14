# On-premises installation (Vingcard / Visionline server)

Since release 2.5 the platform can run entirely on a hotel's Visionline server, with no cloud hosting. This guide is for the
hotel's IT partner. The short version for the person at the server is `onprem\README.txt` in the package.

## What runs where

```
                       Visionline server (Windows)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  Visionline ◄── connector (service) ──► platform 127.0.0.1:4000 (service)  │
 │                                              │                             │
 │                                        PostgreSQL (localhost only)         │
 │                                              ▲                             │
 │                                    gateway (service)                       │
 │                         :8443 hotel network     :9443 external entrance    │
 └──────────────────────────────┬──────────────────────┬─────────────────────┘
                                │                      │
                    hotel LAN / Wi-Fi           hotel firewall: public IP:443 → server:9443
                  (portal, staff phones)        only the hotel's own public IP(s)
```

| Part | Windows service | Listens on | Notes |
|---|---|---|---|
| Platform (API, portal, jobs) | `StaffMobileKeyPlatform` | 127.0.0.1:4000 only | Never reachable from another machine |
| Gateway (HTTPS front door) | `StaffMobileKeyGateway` | 8443 (LAN), 9443 (external, optional) | Allow-lists, secret path, security headers, access log |
| Connector | `StaffMobileKeyConnector` | 127.0.0.1:8090 (status page) | Talks to Visionline on the same server, outbound to the platform |
| Database | PostgreSQL 16 | localhost:5432 | Daily backup at 02:30 |

All three services run as **LOCAL SERVICE**, start with Windows and restart themselves after a failure. The
service host (`StaffMobileKeyHost.exe`) is compiled on the server from `service\NodeService.cs` by the
installer with the C# compiler that is part of Windows: no third-party wrapper.

## Prerequisites

- Windows Server 2016+ (or Windows 10/11 Pro), administrator rights, about 1 GB free disk.
- Node.js 22 LTS for all users, PostgreSQL 16 (keep port 5432, note the `postgres` password).
- Outbound HTTPS from the server to `hospitality.credential-services.api.assaabloy.com` (ASSA ABLOY Credential
  Services). Nothing inbound from the internet is needed for keys to work.

## Installing (any hotel)

Nothing about a particular hotel is built into the package: the hotel is given once, to the installer, and
everything else (logo, colours, details, system number, user groups) is set afterwards in the portal.

```powershell
# PowerShell "Run as administrator", in the unzipped staff-mobile-key-onprem folder
Unblock-File .\*.ps1; Unblock-File .\connector\*.ps1

# First installation (example values - use the hotel's own)
.\install-onprem.ps1 -HotelName "K Hotel Bana" -TimeZone Africa/Douala -Country CM -SystemId 3460 `
    -ServerName vingcard-srv.khb.local `
    -ExternalPort 9443 -AllowExternal "41.202.219.10/32"
```

The installer creates the `smk` database and role (random password), stores every secret encrypted with
Windows DPAPI for this machine, makes a certificate, writes the gateway settings, opens the firewall, creates
the hotel and its first administrator, installs and starts the services, schedules the backup and installs the
connector with an automatically registered token.

| Option | Meaning | Kept on upgrade |
|---|---|---|
| `-HotelName "..."` | Hotel name in the portal, the app and on reports (first installation) | yes |
| `-TimeZone Africa/Nairobi` | Hotel time zone, IANA name (first installation) | yes |
| `-Country KE` | Two-letter country code (first installation) | yes |
| `-SystemId 3460` | ASSA ABLOY System ID (Visionline Options -> Mobile Access); also the default *system number* on reports | yes |
| `-HotelCode` | Short code used in links (default made from the name) | yes |
| `-SupportEmail`, `-SupportPhone` | Shown in the staff app | yes |
| `-ServerName` | Name or IP in the portal address and the certificate | yes |
| `-LanPort 8443` | Port for the hotel network | yes |
| `-ExternalPort 9443 -AllowExternal "..."` | External entrance and the public addresses allowed in (see below) | yes |
| `-RemoveExternal` | Close the external entrance | - |
| `-CertPfx C:\certs\portal.pfx` | A real certificate instead of the self-signed one | yes |
| `-SkipConnector` | The connector is installed (or stays) elsewhere | - |
| `-VisionlineUrl`, `-CaFile`, `-ReadOnly`, `-NoWatch` | Passed to the connector. **Do not use `-ReadOnly` on the hotel's own server** - it stops key issuing; it is only for testing against another hotel's Visionline | connector keeps them |

**Upgrade:** unzip the new version and run `.\install-onprem.ps1` with no options; the hotel, ports, allowed
addresses, secret path and certificate are remembered.

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

The automated checks run the full suite in this mode (191 checks). One thing is not available without callbacks:
the *first use at a door* time (Credential Services READBACK). Lock events from Visionline still arrive through
the connector.

## Certificates

The installer makes a self-signed certificate for `-ServerName` (3 years). Browsers and phones warn until it is
trusted: either install the certificate (fingerprint printed by the installer) on the hotel's PCs and phones,
or, better, use a real certificate for a name the hotel owns (for example `access.khotelbana.com` pointing to
the public IP outside and to the server inside) and pass it with `-CertPfx`.

## Files and secrets

| Path | Content |
|---|---|
| `C:\Program Files\StaffMobileKey\Platform` | Program (app\*.mjs, portal, migrations, scripts) |
| `...\Platform.previous` | The version before the last upgrade (for rollback) |
| `C:\ProgramData\StaffMobileKey\Platform\platform.env` | Plain settings |
| `...\platform.secrets`, `...\gateway.secrets` | DPAPI-encrypted: database URL, JWT and callback keys, Credential Services user and password, cookie key, certificate password |
| `...\gateway.config.json` | Listeners, allow-lists, secret path |
| `...\logs\` | platform.log, gateway.log, gateway-access.log, backup.log (rotated, 10 MB × 5) |
| `...\backups\` | Daily dumps (14 kept) and pre-upgrade dumps — SYSTEM and Administrators only |

The secrets files are readable only by SYSTEM, Administrators and LOCAL SERVICE. Change the Credential Services
password with `set-platform-secrets.ps1` (it never shows or logs it).

## Backups, upgrade, rollback

- **Backup:** daily at 02:30 (`backup-onprem.ps1`); copy `backups\` off the server regularly.
- **Upgrade:** unzip the new package, run `install-onprem.ps1` with the same options. It dumps the database
  first (`pre-upgrade-<version>-*.dump`), keeps the old program in `Platform.previous`, applies new database
  migrations at start and checks `/healthz` before starting the gateway.
- **Rollback:** `rollback-onprem.ps1` (program files) or `rollback-onprem.ps1 -RestoreDatabase` (also the
  database as it was before the upgrade — data entered since is lost; you confirm by typing YES).
- **Uninstall:** `uninstall-onprem.ps1` keeps data and the database; `-RemoveData` also deletes settings and
  backups after confirmation.

## Building the package

```bash
npm run build:portal && npm run package:connector && npm run package:onprem
# -> dist/onprem/staff-mobile-key-onprem-<version>.zip
```

Each program is one bundled file (`platform.mjs`, `gateway.mjs`, `admin.mjs`, `cs-check.mjs`); the server needs
no `npm install`.
