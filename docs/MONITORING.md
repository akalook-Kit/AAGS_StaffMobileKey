# Monitoring, alerts by e-mail and SMS (release 2.7)

**Monitoring** (portal menu) watches the doors, the watched (VIP) doors, the locks and the server, and tells the
right people by e-mail and/or SMS. The check runs every minute; the page refreshes by itself every 30 seconds.
A red band appears at the top of **every** portal page while a critical system alert is open (disk space,
connector or Visionline down) and stays red until the problem is fixed.

## What raises an alert

| Alert | When | Severity | Category (who is told) |
|---|---|---|---|
| Door offline | The lock reports an "offline" event code you set; or Visionline has an open alarm whose type/text contains "offline", "communication", "no contact", "lost contact"; or a lock that usually reports (at least 3 times in 7 days) has been silent for 24 hours | critical (event/alarm), warning (silence) | Doors offline |
| Door back online | The lock reports again (or its "online" code) - the alert closes | - | Doors offline |
| First entrance at a watched door | First entrance each day (or every entrance, or the first only) at a door you chose | notice | Watched doors (VIP) |
| Lock alarm | Open Visionline alarm in the last 24 h (from the Visionline read in Reports & sync) | critical | Lock alarms and batteries |
| Battery critically low | Battery module | critical | Lock alarms and batteries |
| Connector offline | No contact for 10 minutes | critical | System |
| Visionline not reachable | The connector reports it cannot reach the Web API | critical | System |
| **Disk space low** | Less than **50 GB** free on C: of the platform server, or of the Visionline PC (connector 0.8.0 reports it) | critical, **red until fixed** | System |
| **Database large** | Database bigger than **500 MB** | warning | System |

All limits are in **Settings -> Alert thresholds**. An alert is announced once when it opens and (optionally) once
when it is over; the same problem coming back within 60 minutes is not announced again. **Mark as seen** records
who is handling it; it does not silence a disk or connector alert.

### About "door offline"

Visionline does not publish a lock's network status in its Web API, so the platform uses what the locks do report:

1. **Lock event codes** for "offline" / "back online", if the hotel's lock or online system reports them. Put
   the numbers in Settings -> Alert thresholds; the connector then listens for them (connector 0.7.0+ with the
   Visionline watch on).
2. **Visionline alarms** about lost communication (needs "Web service for checking and confirming alarms" and the
   Visionline read in Reports & sync).
3. **Silence**: a busy lock that suddenly stops reporting. Quiet doors (a storeroom used once a week) stay
   "unknown" instead of raising false alarms. Silence is not counted while the connector's watch is not running.

## Watched (VIP) doors

**Monitoring -> Watched doors (VIP)**: choose a door, give it a label ("VIP - Presidential Suite") and choose
*First entrance each day*, *First entrance only, then stop* or *Every entrance*. The entrance is highlighted (★)
in Monitoring, on the Overview and in the Event log, and announced to the "Watched doors (VIP)" contacts with the
time and the person (when the card belongs to a known person).

## E-mail and SMS

**Settings -> Alerts & notifications.**

- **E-mail** goes through the hotel's own mail server or mailbox (Microsoft 365: smtp.office365.com, port 587,
  STARTTLS; Google Workspace: smtp.gmail.com, 587, with an app password; or the hotel's SMTP server). No cost per
  message.
- **SMS**: there is no free SMS service. Options:
  - **Android phone in the hotel** with the free app *SMS Gateway for Android* in "Local server" mode: the
    platform sends to the phone over the hotel network and the phone sends the SMS from its own SIM, so the cost is
    only the SIM bundle. Give the phone a fixed IP address, keep it charging, and enter its address
    (e.g. `http://192.168.1.50:8080`), its user name and (on the server) its password.
  - **Africa's Talking** (paid per SMS, East and West Africa): user name and API key.
  - **Other HTTP SMS service**: address, body template with `{to}` and `{text}`, and the key header.
- **Passwords and API keys never go into the portal or the database.** On the on-premises server set them with
  `set-platform-secrets.ps1` (SMTP password, SMS password/API key); on a hosted platform as the secrets
  `SECRET_SMTP_PASSWORD` and `SECRET_SMS_API_KEY`.
- **Who is told**: add each person with e-mail and/or mobile number (international form, +254...) and the kinds of
  alert they want. **Test** sends a test message; the result shows on the screen and under *Messages sent*.
- Every message is logged with the address masked (du***@hotel.com, +254*****678).

## System health and the database

**Monitoring -> System health** shows the database size against its limit, the largest tables, free space on the
server and on the Visionline PC, the connector, the last automatic backup, and a 30-day trend (sampled hourly).

Database tools on the on-premises server (PowerShell as administrator, in `C:\Program Files\StaffMobileKey\Platform`):

```powershell
.\database-tools.ps1 -Action Size                          # size and largest tables, free space on C:
.\database-tools.ps1 -Action Copy -Destination E:\          # full copy with progress bar, fingerprint (.sha256) and read-back check
.\database-tools.ps1 -Action Verify -File E:\smk-copy-20261015-0800.dump
.\database-tools.ps1 -Action Optimize                       # VACUUM ANALYZE while running ("repair" of statistics and space)
.\database-tools.ps1 -Action Restore -File E:\smk-copy-20261015-0800.dump   # saves the current database first, asks YES
```

The automatic daily backup (02:30, 14 kept) continues as before (`backup-onprem.ps1`). On the Windows test PC the
same tools for the Docker database are `.\scripts\windows\database-tools.ps1 -Action Size|Copy|Optimize|Restore`.

## Empty screens

Where there is no data yet (a new installation, a door that has not reported, no messages sent), the screens say
"No data for now - still looking" with a pulsing dot; they keep refreshing on their own.

## Permissions

| Role | See Monitoring | Mark as seen, contacts, watched doors |
|---|---|---|
| Hotel Administrator, Security Manager | yes | yes |
| Hotel Management, Maintenance Manager, Auditor | yes | no |
| Key Issuer, Technician, Read Only | no | no |

## Test setup

In the Windows test environment the alert messages go to test sinks in the simulator (nothing leaves the PC):
open the lock simulator page and scroll to **Alert messages**. The test contact "Duty manager (test)" receives all
alerts. On the same page **Lock offline / online** sends any lock event code to try the door-offline alert (set
the codes, e.g. 9001 / 9002, in Settings -> Alert thresholds first, then wait a minute for the connector).
Note: in the Docker test setup the platform measures the disk of Docker's virtual machine, not C:. The real C:
is measured by the connector when it runs as a Windows service, and by the platform on the on-premises server.
