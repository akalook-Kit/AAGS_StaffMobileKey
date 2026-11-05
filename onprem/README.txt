STAFF MOBILE KEY - ON-PREMISES PLATFORM (Vingcard / Visionline, any hotel or institution)
=================================================================================

Everything runs on the Visionline server. Nothing is hosted in the cloud, and nothing has to be installed
beforehand: this package carries its own Node.js and PostgreSQL, used only by Access Monitoring Tool.

  Visionline (same server) <-- connector --> platform (127.0.0.1:47300) <-- gateway --> browsers / staff phones
                                                 |                          | 8443  hotel network only
                                       database (127.0.0.1 only)            | 9443  hotel public IP(s) only,
                                                                            |       secret path required

WHAT THE SERVER NEEDS
  - Windows Server 2016 or newer (or Windows 10/11 Pro), 64-bit, an administrator account
  - .NET Framework 4.8 (part of Windows)
  - 2 GB free disk space (more as the database grows; Monitoring warns below 50 GB)

NEW IN 2.26.1
  Connector 0.16.2: reading a card also tries the encoder name with "+" for its space ("Encoder .96"); if nothing
  works, Visionline's answer to each form is shown. An older connector is pointed out in the message.

NEW IN 2.26
  Reading a card at the encoder works whichever name your Visionline uses for the read action ("Invalid query
  parameter value" fixed; connector 0.16.1, install with Everything). Visionline's own detail is shown in errors.

NEW IN 2.25
  Demo Hotel with made-up data for testers: one-time invitation links, access for 1, 7 or 14 days, Feedback button on
  every page, feedback list and CSV (Administration → Demo Hotel and testers; docs\TESTERS.md).

NEW IN 2.24
  New sign-in page (logo, keycard-and-lock picture, what each team does, help for a forgotten password), shortcuts
  on the Overview, page titles, a clearer phone menu, no listing by search engines. Updated e-mail library.

NEW IN 2.23
  Staff keycards → Verify & extend: read a keycard on an encoder (Visionline says whose it is and until when it works)
  and give it a new expiry date (180 / 360 / 730 days or a date), also for a card that had ended. Connector 0.16.0.

NEW IN 2.22
  Verify a keycard with Visionline now: Card lookup (Verify with Visionline) and Staff keycards (Verify keycard).

NEW IN 2.21
  Connector 0.15.0: no more false "Visionline cannot be reached: read ECONNRESET" alarms (idle connections closed
  first, a read is resent once, the alarm needs 3 minutes without Visionline). "Issued from Visionline" with the
  Visionline operator and the person linked to it; staff keycards record who issued them. A battery alarm closes
  after 2 cards. New generic-name keycards are e-mailed to the administrators. set-tunnel-access.ps1 -QuickTest:
  try outside access now with a temporary Cloudflare address, no domain needed.

NEW IN 2.20
  "Stale" is back. Days each battery set lasted (Battery status and Lock troubleshooting). A battery alarm closes by
  itself after 3 cards accepted without the low flag. Visionline is read on request (Refresh from Visionline, at most
  every 5 minutes) instead of every few hours. Staff keycard expiry is a date. Keycards in generic names are flagged to
  the administrators. Setup report: worth a look, user groups vs. rooms (every room), system parameters from the
  Visionline System settings report. Outside access without a public IP: set-tunnel-access.ps1 (Cloudflare Tunnel,
  docs\EXTERNAL-ACCESS.md). Security review fixes (sessions end on password change, one-time two-step codes).

NEW IN 2.19
  A battery alarm after new batteries (within 14 days), not confirmed by a low reading, is a firmware fault: no
  battery alarm, the portal asks to "Program the lock and upload firmware". 3-4.8 V locks are critical at 3.6 V.
  "No battery report available" for locks not heard from (2.20: "stale" again). Lock troubleshooting asks for the lock model (Signature
  RFID, Essence, Classic RFID, Allure), remembered per door, and guides the technician through the causes step by step
  (elimination method). New page Online locks & gateways: online locks in contact or offline, gateways with their EEID
  (added or imported), offline alarms that close by themselves when the lock or gateway is back.

NEW IN 2.18
  New batteries close the battery alarm by themselves: the reading a lock gives right after new batteries ("below
  4.8 volts", or 9.0 V) resolves the alarm and its maintenance request. Lock troubleshooting (Building -> Lock troubleshooting): upload the event report of one lock
  exported from Visionline (older or newer column layout), confirm the door, and get a verdict, what to do in order,
  battery periods and consumption, faults week by week, door problems (left open, opened with no card, mechanical key),
  refusals, use by hour/weekday and card type, service history and online pings. Names, card and serial numbers in the
  file are not kept.

NEW IN 2.17.2
  Fixes "The answers could not be saved: Method not found: 'System.String System.String.TrimEnd(Char)'" in the setup
  window (then error 1722): the installer's small helper programs are now built strictly for .NET Framework 4.

NEW IN 2.17.1
  Fixes error 1722 at the end of the 2.17.0 installation ("A program run as part of the setup did not finish as
  expected"): the installer now checks that the portal (or the connector) is running instead of taking the code of the
  last Windows command. Nothing else changes.

NEW IN 2.17 (ACCESS MONITORING TOOL)
  One .msi installs the portal, the connector, or both: a small window asks at the start (Everything / Portal only /
  Connector only, and the addresses). No console windows appear; tick "Show the installation steps" (or run
  msiexec /i AccessMonitoringTool-Server-2.17.2.msi SMK_SHOW=1) to follow the log. Logs: C:\ProgramData\StaffMobileKey\
  setup-logs. Upgrades keep the answers; SMK_ASK=1 asks again. Staff mobile keys are off by default (Settings ->
  Modules). Notice board and a livelier sign-in page, My charts, Visionline reports imported into the System setup
  report (System settings, operators, card list), issued-by for every card made from the portal, mobile keys made in
  Visionline recognised (serial FFFFFFFF), issuing from an existing keycard, users linked to their keycards, encoder
  choice on Card lookup (Connector 0.14.0). Install folders and service names stay "StaffMobileKey" so upgrades keep working.

NEW IN 2.16
  Hotel or institution (chosen on the setup page; Settings -> Name & details -> Type); fewer "hotel" words in the
  portal. Users -> Invite someone: a one-time link with which the person chooses their own password (72 hours),
  New link / Password link / Remove. "Getting started" checklist on the Overview. The connector can run on ANOTHER
  computer of the network: Settings -> Connector writes the commands; on this server run
      & "C:\Program Files\StaffMobileKey\Platform\set-connector-access.ps1" -Allow <connector computer IP>
  (lets only that address use the connector entrance on port 8443 and saves gateway.cer for it; -StopLocalConnector
  switches off a connector installed here). Install without the built-in connector:
      msiexec /i StaffMobileKey-Server-2.16.1.msi SMK_OPTIONS="-SkipConnector"
  Also from 2.15: keycards per room (who issued them), battery last changed, "program the lock and upload firmware".
  Connector 0.13.1. Quick start: QUICK-START in Help and manual.

NEW IN 2.14
  Staff keycard requests (also from a QR code page, no sign-in), issued in Visionline from an encoder or recorded
  from the Visionline desk, the keycard register (HK 001...), returns on resignation with e-mails to HR and security,
  renewal reminders; unpaid-guest lock-outs (checkout for online locks, 1-minute card for offline locks) with manager
  approval; departures (checkout confirmed / clearance card placed); emergency, stand-open, clearance and one-time
  cards; emergency open of every guest room with an online lock; Accounts daily report by e-mail; System setup report;
  "To do now" on the Overview. Connector 0.12.0.

NEW IN 2.13
  Live occupancy and Emergency (Safety menu; role "Safety / fire warden" for the security-desk screen), staff ID
  cards printed on CR80 keycards, dark mode, personal menus and "Visionline only" focus, a licence window when the
  licence ends, Usage (and a signed summary for your supplier), two-step sign-in required for administrators
  (Settings -> Administrator protection), data retention (Settings -> Privacy & retention), the user manual in the
  portal (Help and manual). The connector (0.11.0) sends at most 2 requests at a time to Visionline so the PMS and
  GRMS are never crowded out. Upgrading keeps data, settings and licence.

INSTALL WITH THE .MSI (2.12)
  Double-click StaffMobileKey-Server-<version>.msi on the Visionline server (administrator). It installs exactly
  what Install.cmd installs, then opens the portal (Start menu: "Access Monitoring Tool"). Silent:
    msiexec /i StaffMobileKey-Server-<version>.msi /qn /l*v smk-install.log  [SMK_OPTIONS="-LanPort 9443"]
  Upgrade: run the newer .msi. Uninstall (Windows Apps) keeps the hotel's data.

LICENCE (2.12)
  A new installation runs as a 60-day trial. Send your supplier the hotel name, ASSA ABLOY System ID and the
  installation ID from Settings -> Licence; enter the licence key (.smklic) they send in the same place.

INSTALL WITH THE ZIP
  1. Unzip the package, for example to C:\Vingcard Files\Onprem\
  2. Double-click Install.cmd (Windows asks for administrator rights). No questions are asked.
  3. At the end the portal opens on this server with the FIRST-RUN SETUP page and the setup code filled in.
     Enter the hotel's details (name, time zone, country, ASSA ABLOY System ID), the first administrator,
     and optionally the Credential Services account. Then sign in.
     The setup code is also in C:\ProgramData\StaffMobileKey\Platform\setup-code.txt (administrators only).
  4. In the portal: Connector health (the connector on this server shows Online), Settings -> Visionline
     (Visionline account, encrypted for the connector), Branding, then Account -> two-step sign-in.

  Install.cmd options (add them after the name in a command prompt, all optional):
    -ServerName vingcard01.hotel.local   name staff use for this server (default: the computer name)
    -LanPort 8443                        HTTPS port on the hotel network
    -PlatformPort 47300                  internal port of the platform (127.0.0.1 only). Default 47300 or the next
                                         free one; never 4000 (often used by PMS interfaces)
    -ExternalPort 9443 -AllowExternal "41.202.219.10/32"   outside access (see below)
    -CertPfx C:\certs\server.pfx         a real certificate instead of the self-signed one
    -NoBrowser                           do not open the portal at the end
    -ReadOnly -NoWatch                   ONLY for tests against a Visionline that is not the hotel's own
                                         (never on the hotel's own server: it stops key issuing)

PORTS
  8443 (hotel network) and, if opened, the external port: the only ports other computers can reach.
  On 127.0.0.1 only: platform 47300 (or the next free one), database 5433 (or the next free one), connector
  status page 8090 (47390 if 8090 is taken). The installer prints the ports it used at the end.
  Upgrading from 2.10 or older moves the platform off port 4000 automatically.

WHAT IS INSTALLED
  Programs:  C:\Program Files\StaffMobileKey\   (Platform, Connector, Runtime)
  Data:      C:\ProgramData\StaffMobileKey\     (database, settings, encrypted secrets, logs, database copies)
  Services:  StaffMobileKeyDatabase (NETWORK SERVICE), StaffMobileKeyPlatform, StaffMobileKeyGateway,
             StaffMobileKeyConnector (LOCAL SERVICE). All start with Windows and restart on failure.
  Desktop:   "Access Monitoring Tool" shortcut to the portal.
  Runtime\VERSIONS.txt lists the bundled Node.js / PostgreSQL versions and the SHA-256 of every program
  file, for the hotel's antivirus or application allow-list.

PASSWORDS
  Typed in the portal, stored encrypted, never shown again:
    Settings -> Credential Services -> Passwords and keys      (ASSA ABLOY account)
    Settings -> Alerts & notifications -> Passwords and keys   (mail server password, SMS key)
    Settings -> Visionline                                     (Visionline account, encrypted for the connector)
  The database password, the session key and the certificate password are made by the installer and kept
  encrypted with Windows DPAPI. set-platform-secrets.ps1 is only for special cases (values set there win).

VISIONLINE CERTIFICATE
  The installer reads Visionline's certificate from https://localhost/api/v1 on this server and trusts
  exactly that certificate (verification stays on). If Visionline runs on another computer or was not
  reachable, the installer says so: run connector\visionline-probe.ps1 -TlsOnly -SaveCert C:\vl.crt, check
  the fingerprint with the Visionline administrator, then Install.cmd -CaFile C:\vl.crt (see the guide).

OUTSIDE ACCESS ("public IP + special pathway")
  1. On the hotel firewall/router: forward TCP <public IP>:443 to <server LAN IP>:9443. Nothing else.
  2. Only addresses in -AllowExternal can even open a connection; others are dropped before TLS.
  3. The first visit must be https://<public IP>/<secret path>/ - it gives the browser a 12-hour pass.
     Without the path or a pass, the answer is "Not found". 20 misses ban the address for 30 minutes.
  4. Sign-in (with two-step sign-in for administrators) is still required after that.
  Change it later: set-external-access.ps1 -Show | -AllowExternal ... | -AddAddress ... | -Disable
  Credential Services is POLLED from the server (outbound HTTPS only); nothing comes in from the internet
  for keys.

DAY-TO-DAY (the tools are also in C:\Program Files\StaffMobileKey\Platform)
  Portal (hotel network):  https://<server name>:8443/      On the server itself: http://127.0.0.1:47300/ (shown by the installer)
  Database copies:         every day at 02:30 (14 kept) and "Back up now" in Settings -> Backups,
                           in C:\ProgramData\StaffMobileKey\Platform\backups  - copy that folder off the server
  Database tools:          .\database-tools.ps1 -Action Size | List | Copy -Destination E:\ | Verify -File ...
                                                | Optimize | Restore -File ...
  Logs:                    C:\ProgramData\StaffMobileKey\Platform\logs\   (install-*.log for each installation)
  Restart:                 Restart-Service StaffMobileKeyPlatform, StaffMobileKeyGateway

UPGRADE
  Unzip the new version and double-click its Install.cmd. Everything is kept (hotel, settings, passwords,
  ports, allowed IPs, certificate). A copy of the database is made first (backups\smk-*-pre-upgrade.smkbak)
  and the old program is kept in "Platform.previous".
  Older versions that used a separately installed PostgreSQL keep using it.

ROLLBACK
  .\rollback-onprem.ps1                       program files only
  .\rollback-onprem.ps1 -RestoreDatabase      also the database as it was before the upgrade

UNINSTALL
  Uninstall.cmd                 removes services and programs, KEEPS the data (Install.cmd uses it again)
  Uninstall.cmd -RemoveData     also deletes the database, settings and copies (asks first)

SECURITY NOTES
  - The platform and the database listen on 127.0.0.1 only; only the gateway port(s) are open.
  - The database runs as NETWORK SERVICE, the platform, gateway and connector as LOCAL SERVICE; none as
    an administrator. The data folder is readable by SYSTEM, Administrators and those accounts only.
  - Database copies contain the whole database: keep the copies you take off the server safe.
  - Full guide: docs\ON-PREMISES.md in the project.
