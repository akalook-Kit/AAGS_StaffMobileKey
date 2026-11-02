# Selling to other hotels: licences, the installer and keeping the platform yours (2.12, 2.13)

## The short answer

You do **not** have to set up every hotel yourself, and the hotel never gets your source code.

1. You give the hotel **one file**: `StaffMobileKey-Server-<version>.msi` (or the zip with `Install.cmd`).
2. The hotel's IT installs it on their Visionline server (double-click, or silently with `msiexec`). It carries its
   own Node.js and PostgreSQL; nothing else is installed.
3. The portal opens on the **first-run setup** page: the hotel enters its own name, time zone, ASSA ABLOY System
   ID, first administrator and Visionline account. You are not needed for this.
4. The installation runs as a **60-day trial** with every module. The hotel sends you its name, its ASSA ABLOY
   System ID and the **installation ID** shown in *Settings → Licence*.
5. You issue a **licence key** in the **License Manager** on your PC (offline) and e-mail the `.smklic` file.
   The hotel enters it in *Settings → Licence*. Done.

When a licence ends, the hotel has 14 days of warnings; after that the portal pauses changes (new keys, settings)
but keeps everything that protects the hotel working: signing in, revoking keys, reading reports, entering a new
licence. Door access in Visionline is never affected.

## What a licence contains

| Field | Meaning |
|---|---|
| Licence number | e.g. `L202610-9VELW`, for your invoices |
| Customer, hotel | Shown in Settings → Licence |
| ASSA ABLOY System ID | Ties the licence to one Visionline system (optional; leave empty to allow any) |
| Modules | Staff mobile keys, Battery status, Maintenance, Time & attendance, Breakfast. Always included: Visionline data, Insights, Event log, Access history, Monitoring, Audit trail |
| Valid until | Optional end date (e.g. a yearly subscription); no date = perpetual |
| Support and updates until | Informational |

The key is `SMK1.<content>.<signature>`: the content is signed with **your** private key (Ed25519). The platform
holds only the public key, so it can check a licence but never make one. Changing a single character (another
date, another module) breaks the signature and the licence is refused. Licences are checked offline; the server
never calls out.

Switching modules off: a module not in the licence cannot be switched on (Settings → Modules says so), and is
switched off when such a licence is installed (its data is kept).

## The License Manager (your PC)

`SMK-License-Manager.html` — open it in Chrome or Edge on **your** PC; it works without internet and sends
nothing anywhere.

- **Signing key**: load `smk-vendor-key.json` with your passphrase. The first time, you receive the key
  *unprotected*: use **Protect this key** with a passphrase of your own (12+ characters), keep the protected
  `smk-vendor-key.json` (and a copy on a USB stick in a safe), then **delete the unprotected file**.
- **Issue a licence**: customer, hotel, System ID, modules, end date → **Create licence** → **Download .smklic**.
- **Issued licences**: your register, kept in this browser; **Back up (JSON)** and **Export CSV** regularly.
- **Check a licence**: paste a key to see what it contains and whether your key signed it.

Whoever has the private key (and its passphrase) can make licences: keep it like a company stamp. If you ever want
a brand-new key, use **Make a new key** and send the *public* key (shown on screen) to your developer: the next
release accepts it (the old one can be kept or retired).

## Who your clients are and how they use it (2.13)

Each hotel's administrators see their own use in **Administration → Usage**: people using the portal, the most used
pages, what it did (keys, card lookups, reports, attendance records, ID cards…) and an estimate of the time saved,
with the minutes per task editable.

For you, the supplier: **Usage → Summary for the supplier** downloads a `.smkusage` file with **counts only** (no
names, e-mails, guests or doors): hotel, installation ID, licence, version, number of doors and Visionline people,
active users, pages opened per area and outcomes. It is signed with a key created by that installation (kept encrypted
on the server), so an edited file shows as *Edited*. Nothing is sent automatically: ask the hotel to e-mail it with
each licence renewal (or quarterly).

In the License Manager, **Clients & usage → Add usage summaries…** reads the files (several at once) and keeps one row
per installation: hotel, licence, version, size, active users, pages, keys, reports, most used pages and the
signature check; **Export CSV** for your own reporting. A file signed by a different key for the same installation
(reinstalled server) shows *New key*.

## Licence window (2.13)

When a licence (or the trial) has ended, administrators get a window on every page to paste the new key or open the
`.smklic` file; other users are told to ask an administrator. *Later* hides it until that browser tab is closed.

## Keeping the platform yours

- **Programs, not source code.** The hotel receives bundled, minified programs (`app\*.mjs`), the database
  migrations and the portal's built files. The TypeScript source, tests and tools stay in your Git repository.
  Like any software installed on a customer's server it can in principle be inspected, which is why the licence
  terms (your contract) matter as much as the technical checks.
- **Or host it yourself.** The same platform runs in the cloud for many hotels at once (Render/Docker, see
  DEPLOY-RENDER.md). Then the backend never leaves your hands: each hotel only installs the **connector** on its
  Visionline server (outbound HTTPS to your platform), and you create each hotel and its first administrator
  yourself (platform administrator account, `POST /api/v1/hotels`, or the provisioning tool in DEPLOY-RENDER.md). Licences are not needed there (you control access directly); the trade-off
  is that you run and back up the servers.

## The installer (.msi)

`StaffMobileKey-Server-<version>.msi` wraps the same package as `Install.cmd`:

- Copies the package to `C:\Program Files\StaffMobileKey\Setup` and runs the installer as SYSTEM (database,
  platform, gateway and connector services, firewall rules, certificate). Upgrades: install the newer `.msi`;
  hotel data, settings and licence are kept. Uninstall (Windows *Apps*): removes services and programs, **keeps**
  the hotel's data in `C:\ProgramData\StaffMobileKey` (delete it with `Uninstall.cmd -RemoveData` if really wanted).
- Start menu: **Staff Mobile Key** opens the portal on that server (the first-run setup page with its code, before
  setup; Windows asks for administrator rights to read the code).
- Silent installation for IT departments:

      msiexec /i StaffMobileKey-Server-2.13.0.msi /qn /l*v smk-install.log
      msiexec /i StaffMobileKey-Server-2.13.0.msi SMK_OPTIONS="-LanPort 9443 -ServerName vl01.hotel.local"

  `SMK_OPTIONS` takes the same options as `Install.cmd` (see the package README).
- The installation log is in `C:\ProgramData\StaffMobileKey\Platform\logs\install-*.log`.

**Sign the .msi** before giving it to hotels: unsigned installers show "Unknown publisher" and SmartScreen
warnings. Buy a code-signing certificate in your company's name (OV or EV, from DigiCert, Sectigo, GlobalSign…),
then on your PC run `installer\msi\sign-msi.ps1 -Msi .\StaffMobileKey-Server-2.13.0.msi -Pfx C:\certs\codesign.pfx`
(or `-Thumbprint` for a USB token). Optionally set your company name for Windows *Apps* when building:
`SMK_MSI_MANUFACTURER="Your Company Ltd" npm run package:msi`.

### Building it yourself

The `.msi` is built from the on-premises package with `wixl` (msitools) on Linux or WSL on your PC:

    sudo apt-get install wixl msitools           # once (Ubuntu / WSL)
    npm ci && npm run build:portal
    npm run package:connector && npm run package:onprem && npm run package:msi
    # -> dist/msi/StaffMobileKey-Server-<version>.msi  (+ .sha256)
    npm run package:license-manager               # -> dist/license-manager/SMK-License-Manager.html
