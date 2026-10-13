# The hotel connector

## What it is and where it runs

The connector is the only part of the platform that talks to Visionline. It is a small Node.js program
that runs as a **Windows service** named **Staff Mobile Key Connector** (`StaffMobileKeyConnector`)
on the **Visionline PC**, or on a PC on the same network that can reach the Visionline Web API.

```
 Portal / staff app ──► Platform (backend + database) ◄── outbound HTTPS only ── CONNECTOR ── HTTPS ──► Visionline Web API
                                                         (long poll every 20 s)   (Windows      https://localhost/api/v1
                                                                                   service)            │
                                                                                                       ▼
                                                                                    Visionline server → locks, SEOS / Credential Services
```

| Question | Answer |
|---|---|
| Where is the code? | `apps/connector` in the project. Released as `staff-mobile-key-connector-<version>.zip` (one JavaScript file with all dependencies, plus the installer). |
| What service runs? | `StaffMobileKeyConnector`, display name *Staff Mobile Key Connector*. It runs as **LOCAL SERVICE** (no admin rights), starts with Windows (delayed start) and restarts on failure. |
| What does the service start? | `StaffMobileKeyConnector.exe`, a small service host compiled during installation from `service\ConnectorService.cs` with the C# compiler built into Windows. It starts `node connector.mjs`, restarts it if it stops, and writes `logs\connector.log`. |
| Where are its files? | Program: `C:\Program Files\StaffMobileKey\Connector`. Data: `C:\ProgramData\StaffMobileKey\Connector`, holding `connector.config.json`, the encrypted `secrets.enc`, `master.key.dpapi`, the command journal and `logs\`. The data folder is readable only by SYSTEM, Administrators and LOCAL SERVICE. |
| Which ports? | **None inbound.** The connector only makes outbound connections, to the platform (HTTPS) and to Visionline. Its status page listens on `127.0.0.1:8090` (this PC only, password protected). |
| Test setup on your PC | The `connector` container in Docker does the same job against the simulator. To run the real Windows service on your PC instead, see [CONNECTOR-LOCAL-TEST.md](CONNECTOR-LOCAL-TEST.md). |

## How it queries Visionline

It follows the ASSA ABLOY **Web API** document 61 1100 080 rev 74:

1. **Session.** It sends `POST /api/v1/sessions` with the Visionline operator's user name and password,
   plus the access ID if the web client needs one (§5.24). The web client is set to *Ignore operator card*.
   Visionline answers with a session id and an access key.
2. **Signed requests.** Every other request is signed with HMAC-SHA1 using that access key
   (`Authorization: AWS <session id>:<signature>`, §4.5). The signing code is tested against the worked
   examples in §7.1.3–7.1.4. If Visionline reports clock skew (40101) or an expired session (40103), the
   connector adapts and resends; both mean the request was not carried out.
3. **TLS.** The connection is HTTPS, TLS 1.2 or newer, and the certificate is always verified against the
   file you give (`-CaFile`), optionally pinned. There is no setting that turns verification off.
4. **Work from the platform.** The connector long-polls the platform (`/connector/v1/commands/lease`) and
   runs each command against Visionline:

   | Command | Visionline calls |
   |---|---|
   | Discover doors, user groups, accounts | `GET /resources`, `GET /doors?details=true`, `GET /userGroups/{id}`, `GET /timeSchedules`, `GET /mobileaccess` |
   | Issue a staff mobile key | `GET/PUT /users/{id}` (card holder), then `POST /cards?action=mobileAccess` with doors, end (and start), `endPointID`, `accountName`, optional `override=true` → returns the `credentialID`; then `GET /cards?cardHolder=…` + `GET /cards/{id}` to find the card's **reg. no.** |
   | Revoke (check out) | `POST /doors/{door}` `{checkedOut: true, credentialID}` for each door on the key (§7.13.5) |
   | Revoke (cancel card) | `GET /cards/{reg. no.}`, then `POST /cards/{reg. no.}` `{cancelled: true}` (§7.7.4) |
   | Create a user group | `PUT /userGroups/{id}` |
   | Check operator credentials | open and close a session |

   Visionline then delivers the key to the phone through Credential Services (SEOS) using the Mobile Access
   account configured in Visionline. The connector does not handle the key itself.
5. **Watching Visionline.** The connector registers a Visionline callback (`POST /callback`, §7.14) for
   card changes and for refused-door lock events, and long-polls it (`GET /callback/{id}`, §7.16). When it
   starts, it also catches up with `GET /cards?cancelTimeSince=…`. It forwards what it sees to the platform:
   - a key's card is **cancelled in Visionline** → the platform revokes the key and the app removes it;
   - the key is refused at a door that is not on it (event **320** *No access to this room* or **323**
     *Card can only access common rooms*) → the attempt is counted, and after **more than 5** the platform
     cancels the card in Visionline automatically;
   - a lock reports a **battery** event (low, critical, exchanged, or "below X volts") → the platform updates
     the door's battery state and alerts (Phase 2, connector 0.5.0; [BATTERY-MAINTENANCE.md](BATTERY-MAINTENANCE.md)).
6. **Results and safety.** Every command has an idempotency key and an expiry. The connector writes each
   step to an encrypted journal. If it stops in the middle of a Visionline call, the command is reported as
   *uncertain*, not repeated blindly. Results that cannot be reported, because the internet is down, are
   kept and sent later.

**Secrets.** The Visionline property operator password can be typed on the status page or in the portal
(**Settings → Visionline**). In the portal, the browser encrypts it with this connector's public key, so
only this connector can read it. Either way it is stored encrypted on this PC, with a key protected by
Windows DPAPI. Secrets are never logged and never sent back.

## Installing on the Visionline PC

Do this with the hotel's IT team and ASSA ABLOY's agreement, and never with development passwords.

**You need:**
- Node.js 22 LTS for all users;
- the connector zip;
- a connector token (portal → **Connector health** → **Register a connector**);
- the Visionline certificate, or its CA, as a `.crt` file.

1. Unzip, then in **PowerShell as administrator** in that folder:
   ```powershell
   Get-ChildItem -Recurse -Filter *.ps1 | Unblock-File
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   ```
2. Check Visionline read-only, without changing anything ([VISIONLINE-PROBE.md](VISIONLINE-PROBE.md)):
   ```powershell
   .\visionline-probe.ps1 -TlsOnly -SaveCert C:\khb\visionline-ca.crt
   .\visionline-probe.ps1 -CaFile C:\khb\visionline-ca.crt -User <operator>
   ```
3. Install:
   ```powershell
   .\install.ps1 -PlatformUrl https://<platform address> -CaFile C:\khb\visionline-ca.crt
   ```
   It asks for the token and a password for the status page.
   - Add `-ReadOnly` to connect to a live Visionline without ever changing it. Discovery, credential checks
     and the watch still work.
   - Add `-ServerName <name>` if Visionline's certificate is issued to another name.
   - Add `-NoWatch` to stop reading Visionline's card and lock events (`-Watch` turns it back on). Without the
     watch there is no automatic revocation of cards cancelled in Visionline, no wrong-door limit and no
     battery monitoring.
4. In the portal:
   1. **Connector health** shows it *Online*.
   2. Enter the property operator in **Settings → Visionline → Change property credentials**.
   3. Run discovery.
   4. Work through the readiness list. *Visionline watch running* should be green.

**Everyday commands** (the zip folder has the scripts):

| Task | Command |
|---|---|
| State | `Get-Service StaffMobileKeyConnector`, or the status page `http://127.0.0.1:8090/` |
| Logs | `C:\ProgramData\StaffMobileKey\Connector\logs\connector.log` (rotated at 10 MB, 5 kept) |
| Restart | `Restart-Service StaffMobileKeyConnector` |
| New token or status-page password | `.\set-secrets.ps1` |
| Upgrade | unzip the new version, run `.\install.ps1` (settings, read-only and watch choices, and secrets are kept) |
| Move to another platform address (e.g. Render) | `.\install.ps1 -PlatformUrl https://<address> -ResetSecrets` and paste the new token ([DEPLOY-RENDER.md](DEPLOY-RENDER.md)) |
| Remove | `.\uninstall.ps1`, and disable the connector in the portal |

**Operations notes:**
- Keep Windows time synchronised: Visionline refuses requests more than 15 minutes off.
- After a crash during a Visionline call, the command shows as *uncertain outcome*. Check Visionline, then
  revoke or reissue from the portal.
- Moving to another PC: register a new connector (tokens are bound to one installation). Re-enter the
  property credentials; operators re-enter their personal Visionline credentials.
