STAFF MOBILE KEY - HOTEL CONNECTOR FOR WINDOWS
================================================

What it is
----------
A small Windows service ("Staff Mobile Key Connector") that sits next to Visionline. It is the only
part of the platform that talks to Visionline:

  platform (cloud or your PC)  <-- outbound HTTPS --  CONNECTOR  -- HTTPS, signed -->  Visionline Web API
                                                                                       https://localhost/api/v1

- It asks the platform for work (long poll) and reports results. It never accepts inbound connections.
- It calls the Visionline Web API (ASSA ABLOY doc 61 1100 080) with a Visionline operator: create staff
  mobile keys, check out / cancel them, read doors and user groups.
- It watches Visionline (/callback) for cards cancelled at the Visionline desk and for doors that
  refused a key, and reports them so the platform can remove keys from the app.
  From 0.5.0 it also reports lock battery events (low, critical, exchanged) for battery monitoring.
- Passwords are kept encrypted on this PC only (key protected by Windows DPAPI).

What gets installed
-------------------
  C:\Program Files\StaffMobileKey\Connector    program (connector.mjs, probe.mjs, service host)
  C:\ProgramData\StaffMobileKey\Connector      settings, encrypted secrets, journal, logs\connector.log
  Windows service "StaffMobileKeyConnector"    runs as LOCAL SERVICE, starts with Windows, restarts on failure
  Status page http://127.0.0.1:8090/           this PC only, user "admin"

The service host (StaffMobileKeyConnector.exe) is compiled during installation from
service\ConnectorService.cs with the C# compiler that is part of Windows. No third-party programs.

Requirements
------------
- Windows 10/11 or Windows Server 2016+, PowerShell 5.1 (built in).
- Node.js 22 LTS installed for all users (https://nodejs.org, or: winget install OpenJS.NodeJS.LTS).
- A connector token: portal -> Connector health -> Register a connector.
- For a real Visionline: the Visionline certificate (or its CA) as a .crt file. Run the probe first.

Install
-------
1. Unzip this folder, e.g. to C:\khb\connector.
2. Open PowerShell with "Run as administrator":
     cd C:\khb\connector
     Get-ChildItem -Recurse -Filter *.ps1 | Unblock-File
     Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
3. Check Visionline (read-only, changes nothing):
     .\visionline-probe.ps1 -TlsOnly -SaveCert C:\khb\visionline-ca.crt
     .\visionline-probe.ps1 -CaFile C:\khb\visionline-ca.crt -User <operator>
4. Install:
     .\install.ps1 -PlatformUrl https://<platform address> -CaFile C:\khb\visionline-ca.crt
   It asks for the connector token and a password for the status page.
   Add -ReadOnly to connect to a live Visionline without ever changing it (discovery and checks only).
   Add -NoWatch on a Visionline that is not the hotel's own, so its lock and card events are not read.
   To move to a new platform address (e.g. Render): .\install.ps1 -PlatformUrl https://<address> -ResetSecrets
5. In the portal: Connector health shows the connector Online. Enter the Visionline operator in
   Settings -> Visionline -> Change property credentials, then run discovery.

Testing on your own PC with the simulator: see docs\CONNECTOR-LOCAL-TEST.md in the project.

Everyday
--------
  Status:          Get-Service StaffMobileKeyConnector     or the status page
  Logs:            C:\ProgramData\StaffMobileKey\Connector\logs\connector.log
  Restart:         Restart-Service StaffMobileKeyConnector
  New token/pwd:   .\set-secrets.ps1
  Upgrade:         unzip the new version, then .\install.ps1 (settings and secrets are kept)
  Remove:          .\uninstall.ps1        (add -RemoveData to delete settings and secrets too)
