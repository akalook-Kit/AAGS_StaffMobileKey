STAFF MOBILE KEY - ON-PREMISES PLATFORM (Vingcard / Visionline server, any hotel)
=======================================================================

Everything runs on the Visionline server. Nothing is hosted in the cloud.

  Visionline (same server) <-- connector --> platform (127.0.0.1:4000) <-- gateway --> browsers / staff phones
                                                    |                          | 8443  hotel network only
                                                PostgreSQL (localhost)         | 9443  hotel public IP(s) only,
                                                                               |       secret path required

WHAT YOU NEED ON THE SERVER
  - Windows Server 2016 or later (or Windows 10/11 Pro), administrator rights
  - Node.js 22 LTS installed for all users        https://nodejs.org
  - PostgreSQL 16 for Windows, port 5432           https://www.postgresql.org/download/windows/
    (note the password of the 'postgres' user; it is asked once and not stored)
  - .NET Framework 4.8 (already part of Windows)

INSTALL (PowerShell "Run as administrator", in this folder)
  Unblock-File .\*.ps1; Unblock-File .\connector\*.ps1
  .\install-onprem.ps1 -HotelName "Hotel name" -TimeZone Africa/Nairobi -Country KE -SystemId 1234 `
      -ServerName vingcard-srv.hotel.local
  With an outside entrance (hotel's own public IPs only):
  .\install-onprem.ps1 -HotelName "Hotel name" -TimeZone Africa/Nairobi -Country KE -SystemId 1234 `
      -ServerName vingcard-srv.hotel.local -ExternalPort 9443 -AllowExternal "41.202.219.10/32"

  Nothing about a particular hotel is built in: name, time zone and country are asked once; logo, colours,
  details and the system number printed on reports are set later in the portal.
  The script asks for: the postgres password (once), the Credential Services user/password (or Enter to set
  later), the first administrator's e-mail and password. It prints the portal address, the certificate
  fingerprint and the SECRET PATH for outside access. Keep the secret path like a password.
  Do NOT add -ReadOnly on the hotel's own server: it stops key issuing (it is only for tests against another
  hotel's Visionline).

OUTSIDE ACCESS ("public IP + special pathway")
  1. On the hotel firewall/router: forward TCP <public IP>:443 to <server LAN IP>:9443. Nothing else.
  2. Only addresses in -AllowExternal can even open a connection; others are dropped before TLS.
  3. The first visit must be https://<public IP>/<secret path>/ - it gives the browser a 12-hour pass.
     Without the path or a pass, the answer is "Not found". 20 misses ban the address for 30 minutes.
  4. Sign-in (with MFA for administrators) is still required after that.
  5. Staff app: build it with server address https://<public IP>/<secret path> (see ON-PREMISES.md)
  The connector API and Credential Services callbacks are never reachable from outside. Credential Services
  is POLLED from the server (outbound HTTPS only), so nothing inbound from the internet is needed for keys.

DAY-TO-DAY
  Portal (hotel network):  https://<server name>:8443/
  Logs:                    C:\ProgramData\StaffMobileKey\Platform\logs\
  Backups (02:30 daily):   C:\ProgramData\StaffMobileKey\Platform\backups\   (copy them off the server)
  Change CS password:      .\set-platform-secrets.ps1   (in C:\Program Files\StaffMobileKey\Platform)
  Change allowed IPs:      .\set-external-access.ps1 -Show | -AllowExternal ... | -AddAddress ... | -Disable
  Restart:                 Restart-Service StaffMobileKeyPlatform, StaffMobileKeyGateway

UPGRADE
  Unzip the new version and run .\install-onprem.ps1 (no options needed: hotel, ports, allowed IPs are kept). It backs up the database first
  (backups\pre-upgrade-<version>-*.dump) and keeps the old program in "Platform.previous".

ROLLBACK
  .\rollback-onprem.ps1                       program files only
  .\rollback-onprem.ps1 -RestoreDatabase      also the database as it was before the upgrade

RESTORING A BACKUP (as administrator)
  Stop-Service StaffMobileKeyGateway, StaffMobileKeyPlatform
  & 'C:\Program Files\PostgreSQL\16\bin\pg_restore.exe' -h 127.0.0.1 -U postgres -d smk --clean --if-exists --no-owner `
      C:\ProgramData\StaffMobileKey\Platform\backups\smk-YYYYMMDD-HHMM.dump
  Start-Service StaffMobileKeyPlatform, StaffMobileKeyGateway

UNINSTALL
  .\uninstall-onprem.ps1   (keeps data and the database; add -RemoveData to delete settings and backups)

SECURITY NOTES
  - Secrets (database password, JWT key, Credential Services password, certificate password) are encrypted
    with Windows DPAPI for this machine and readable only by SYSTEM, Administrators and LOCAL SERVICE.
  - The platform listens on 127.0.0.1 only; PostgreSQL should listen on localhost only.
  - Visionline is used read-only when installed with -ReadOnly.
  - Full guide: docs\ON-PREMISES.md in the project.
