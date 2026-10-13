# Testing the Windows connector on your own PC

The test environment includes a connector inside Docker. To try the **real Windows service** instead,
the one you will install on the Visionline PC, install it on your PC and point it at the simulated
Visionline. Nothing changes on your other apps. The service only makes outbound connections, and its
status page is local.

You need:
- the test environment running (WINDOWS-SETUP.md);
- **Node.js 22 LTS installed for all users** ([nodejs.org](https://nodejs.org), or
  `winget install OpenJS.NodeJS.LTS`);
- the connector zip, `staff-mobile-key-connector-<version>.zip`.

> **nvm-windows users:** the service cannot run Node from your user profile. Unzip the Node.js 22
> *Windows Binary (.zip)* to `C:\khb\node22` and add `-NodePath C:\khb\node22\node.exe` to the install
> command.

## 1. Switch the test environment to the Windows-service connector

In your normal PowerShell, in `C:\khb\staff-mobile-key\staff-mobile-key`:

```powershell
.\scripts\windows\start.ps1 -NativeConnector
```

This stops the connector container, so two connectors don't both take commands. It also publishes the
simulated Visionline on `https://localhost:14443/api/v1` (this PC only). It saves the simulator's
certificate to `local-test\visionline-sim-ca.crt`.

## 2. Register the connector in the portal

Sign in as `admin@khb.test`, go to **Connector health → Register a connector**, name it, for example,
*My PC (Windows service)*, click **Create token**, and **copy the token**. It is shown once.

## 3. Install the service

Unzip the connector zip to `C:\khb\connector`. Open **PowerShell as administrator**:

```powershell
cd C:\khb\connector
Get-ChildItem -Recurse -Filter *.ps1 | Unblock-File
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

.\visionline-probe.ps1 -Url https://localhost:14443/api/v1 -CaFile C:\khb\staff-mobile-key\staff-mobile-key\local-test\visionline-sim-ca.crt -User sym
#   password: sym-dev-password   (read-only check; it should end with "No problems")

.\install.ps1 -PlatformUrl http://localhost:14080 -VisionlineUrl https://localhost:14443/api/v1 `
  -CaFile C:\khb\staff-mobile-key\staff-mobile-key\local-test\visionline-sim-ca.crt -AdminPort 14091
```

Paste the token and choose a status-page password when asked. Port 14091 keeps the status page clear of
the usual 8090 on your PC.

## 4. Check it

| Where | What you should see |
|---|---|
| `services.msc` | *Staff Mobile Key Connector*, Running, Automatic (Delayed Start), Log On As *Local Service* |
| `http://127.0.0.1:14091/` (user `admin`) | Platform connection: connected |
| Portal → Connector health | *My PC (Windows service)* Online, version 0.5.0 |
| Portal → Settings → Visionline → Change property credentials | Enter `sym` / `sym-dev-password` → **Test and save**: Visionline accepts it. The password was encrypted for your new connector. |
| Portal → Connector health → Run resource discovery | Doors and user groups appear; readiness turns green, including *Visionline watch running* |

Then try the new behaviour. Use the lock simulator at `http://localhost:14444` with a phone set up in the
staff app, or run `.\scripts\windows\test.ps1 -Fast`:
- issue a key, then on the lock simulator click **Cancel in Visionline** next to its reg. no. Within
  seconds the key shows *Revoked · Card cancelled in Visionline* and leaves the app;
- open a door that is not on the key six times: the 6th attempt cancels the card automatically.

Logs: `C:\ProgramData\StaffMobileKey\Connector\logs\connector.log`.

## 5. Back to the built-in connector

```powershell
.\scripts\windows\start.ps1 -DockerConnector                  # normal PowerShell, project folder
cd C:\khb\connector; .\uninstall.ps1 -RemoveData              # PowerShell as administrator (optional)
```

In the portal, **disable** the *My PC* connector under Connector health.

## Trying it against a real Visionline

You can point the same installation at a real Visionline:
- use `-VisionlineUrl https://<visionline-pc>/api/v1 -CaFile <its certificate>`;
- use **`-ReadOnly`** unless that Visionline is a test system. In read-only mode the connector refuses
  to issue, revoke or create anything. Discovery, credential checks and the watch still work;
- add **`-NoWatch`** when that Visionline belongs to another hotel (such as the JW Marriott Nairobi system
  on the test PC), so its cancelled cards, refused doors and battery alarms are not read or stored.
  `-Watch` turns it back on. The setting is kept when you upgrade.

For example, on the test PC:

```powershell
.\install.ps1 -VisionlineUrl https://localhost/api/v1 -CaFile C:\khb\visionline-ca.crt -ReadOnly -NoWatch
```

Issuing a key to a real phone also needs the licensed ASSA ABLOY mobile SDK in the app and the hotel's
Credential Services account in the platform. Until then, an issue against a real Visionline fails at
Visionline with *endpoint not found* (40052), because simulator phones are unknown to the real SEOS service.
