# Access Monitoring Tool — quick start (2.34.0)

## What it is and what you need

Access Monitoring Tool is a web portal on your own network that works with ASSA ABLOY Visionline. It shows who opened
which door and with which keycard, who holds which keycard and who may open which door, handles staff keycard
requests, watches lock batteries and supports emergencies. It works for a hotel or an institution (offices, a
hospital, a school). Staff mobile keys are an optional module, off by default.

It has two parts: the **portal** (with its database) and the **connector**, which talks to Visionline. One file
installs either or both: `AccessMonitoringTool-Server-2.34.0.msi`.

| | A. One computer | B. Two computers |
|---|---|---|
| Portal | On the Visionline server | On any Windows computer of the network |
| Connector | On the same server | On the Visionline server (or a computer that reaches it) |
| What to run | The .msi, answer *Everything* | The .msi on each computer: *Portal only* on one, *Connector only* on the other |

You also need Windows 10/11 or Windows Server 2016+ (64-bit), a Visionline user that may use the Web API, and the
Visionline Web API reachable over https (usually `https://localhost/api/v1` on the Visionline server). Nothing else
is installed beforehand: the .msi carries its own runtime.

## Light edition (2.34.0): lock diagnosis and day reports

`AccessMonitoringTool-Light-2.34.0.msi` is a lighter version of the same program, for the engineering team of a
hotel with offline locks (made first for La Falaise: its logo and colours are included). Install it on the
Visionline server, like the standard .msi, then:

1. **One page, one setting.** The browser opens *Access Monitoring Tool Light*. Enter the **Visionline user and
   password** (and, if you want, the hotel's name) and click **Connect**. The password is encrypted in the browser
   for the connector on this server. That is all: the portal tests the account, reads the doors and switches
   battery monitoring on by itself. No administrator, no users, no connector or settings pages.
2. **No sign-in on the hotel network.** Any computer of the hotel network opens `https://<server>:8443`.
3. **Home**: locks draining, locks waiting for a report, batteries expected low within 7 days, reminders, charts
   (batteries expected low per week, the locks whose batteries last the least, days a set lasts by year) and
   shortcuts.
4. **Locks**: record work (cables and alignment → battery holder → batteries → LCA → LCU → lock case), *Report a
   problem* on the day the batteries drop (with the voltage at rest and under load), the door an LCA or LCU was
   swapped with, photos of the paper log or the battery holder. When the batteries drop again the portal reminds
   the team: *Upload the latest report of this lock*.
5. **Day report**: one day or a period, floor by floor: what was replaced (as per the paperwork), batteries,
   voltages, the state of each lock, the reminders and the locks to prepare batteries for. **Print** or **Excel**.

The Light and standard .msi can be kept side by side in the same GitHub repository and release; install only one of
them on a given server (the Light .msi installs over the 2.33 La Falaise light edition).

## First setup in 5 steps

1. **Run the .msi** as administrator. A small window asks what this computer runs (*Everything*, *Portal only* or
   *Connector only*) and the addresses. No black windows appear; tick *Show the installation steps* if IT support
   wants to follow the log. For *Connector only*, first make a connector token in the portal (Settings → Connector)
   and run `set-connector-access.ps1 -Allow <connector computer IP>` on the portal server; the window shows the
   portal's certificate fingerprint to compare with the one that script printed.
2. **Setup page.** The browser opens it at the end, with the **setup code** already filled in. If the page asks for
   the code: Start menu → **Access Monitoring Tool - setup code** (Windows asks for administrator permission; the
   code is shown and copied to the clipboard). The file `setup-code.txt` is readable by administrators only, so
   opening it with Notepad from a normal window fails on purpose. Choose **Hotel** or **Institution**, the name, time
   zone and country, and create the first administrator (for a demo: your own e-mail and a password you choose).
3. **Visionline account.** **Settings → Visionline**: the Visionline user and password (encrypted for the
   connector). Use a named Visionline operator, not the PMS / interface user, so Visionline's own log shows who
   made each card.
4. **Visionline reports.** **Administration → System setup reports → Import a Visionline report**: the *System
   settings* report as Visionline saves it, and if you have them the operator list and a card list with the operator.
5. **Checklist.** The **Overview** shows *Getting started* until everything is green.
6. **Your hotel's look.** **Administration → Branding and logo**: the hotel's logo (PNG or SVG), its name as shown
   (e.g. *La Falaise Hotel Bonapriso*) and colours. They appear on the sign-in page, the menu and every printed report.

## Clean installation (a server used for tests before)

The .msi keeps the data of an earlier installation (database, settings, setup code) so that an update never loses
anything. To start from nothing, for example a server where another hotel was installed for a test:

1. **Settings → Apps → Access Monitoring Tool Server → Uninstall** (the services are removed, the data is kept).
2. In PowerShell **as administrator**, after copying anything you want to keep from
   `C:\ProgramData\StaffMobileKey\Platform\backups`:
   `Remove-Item C:\ProgramData\StaffMobileKey -Recurse -Force`
3. Run the new .msi. The setup page opens with a new setup code and the hotel is created from scratch.

## Adding people

**Users → Invite someone**: name, work e-mail, what they do. They get a link (once, 72 hours), choose their own
password and are in. **New link** if it expired, **Password link** for a forgotten password, **Remove** when someone
leaves.

| Choose | They can |
|---|---|
| Administrator | Everything, including settings and users |
| Front office / key desk | Issue mobile keys and staff keycards; ask for unpaid-guest lock-outs (hotels) |
| Security manager | Approve broad keys and lock-outs, emergencies, event log |
| Department manager | Ask for keycards for their team |
| Management (reports) | Reports, event log, keycards per room |
| Maintenance manager | Battery status and maintenance requests |
| HR | Time & attendance, staff ID cards |
| Safety / fire warden | Live occupancy and roll call |
| Auditor (read only) | Read everything, change nothing |

## Everyday tasks

| I want to… | Go to |
|---|---|
| See who opened a door | Event log (Print = verifiable PDF) |
| Find why a lock drains its batteries | Locks → Lock troubleshooting: Record work on a lock (batteries with their type, parts changed), then upload its report 3 weeks later |
| Daily or monthly figures: guest keycards issued, staff keycards issued, who holds staff keycards, refused entries, batteries | Reports (PDF, Excel, e-mail now, or e-mailed every day / month) |
| Visionline version, AES, number of locks on one page | Administration → System setup reports → Visionline setup report |
| Use the portal in French | Automatic when the computer / browser is in French; or Français at the bottom of the menu (also on the sign-in page) |
| See which keycards opened each room, and who issued them | Keycards per room |
| Ask for / make a staff keycard | Staff keycards (Requests, Encode here, or link an *Existing keycard*) |
| Who has a master keycard / who can open the cashier door | Visionline cards & people → Keycards → *Opens* filter and quick buttons |
| Read the card lying on an encoder | Visionline cards & people → Card lookup → choose the *Encoder* |
| Make my own chart | My charts → New chart (pin it to the Overview) |
| Tell everyone something | Overview → Notice board → New post (also on the sign-in page if you tick it) |
| Check lock batteries; "new batteries, still alarming" | Battery status |
| Find out why an offline lock drains its batteries or misbehaves | Lock troubleshooting |
| See which online locks and gateways are offline, with their EEIDs (alarms close by themselves when they are back) | Online locks & gateways |
| Read the latest from Visionline (after uploading lock data or refreshing resources there) | Refresh from Visionline (Visionline cards & people, Battery status, Setup report) |
| Reach the portal from outside without a public IP | EXTERNAL-ACCESS.md (Cloudflare Tunnel) |
| Handle an emergency | Emergency, Live occupancy |
| Know what needs me now | Overview → To do now |

## When something goes wrong

| What you see | What to do |
|---|---|
| Certificate warning in the browser | Normal with the server's own certificate; continue, or install a company certificate (`-CertPfx`). |
| Connector offline | Settings → Connector (last seen, address); start *StaffMobileKeyConnector*; status page `http://127.0.0.1:8090`. |
| "Platform unreachable … certificate" | Run `set-connector-access.ps1 -Allow <address>` again; copy `gateway.cer`; `install.ps1 -PlatformCaFile .\gateway.cer`. |
| "Visionline certificate / unreachable" | `visionline-probe.ps1 -TlsOnly -SaveCert .\visionline.crt`, then `install.ps1 -CaFile .\visionline.crt`. |
| Invitation link does not work | Users → New link. |
| The installation stopped | The log is in `C:\ProgramData\StaffMobileKey\setup-logs`; run the .msi again with `SMK_SHOW=1` to follow it. |
| A lock keeps a battery alarm after new batteries | Program the lock and upload its firmware with the service tool. |
