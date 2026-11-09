# Access Monitoring Tool — user manual (2.29)

New here? Start with **QUICK-START.md** (5 steps, adding people, everyday tasks).

The portal works next to ASSA ABLOY Visionline. Visionline stays the system that encodes keycards and talks to the
locks; the portal reads from it (people, keycards, lock events), adds what Visionline does not do (reports, live
occupancy, ID cards, attendance…) and, where switched on, issues staff mobile keys through it.

Nothing in the portal can lock anybody out: doors keep working exactly as Visionline says, also when the portal or
its server is off.

## 1. Signing in and finding your way

- Open the portal address your IT gave you (for example `https://vl01.hotel.local:9443`) in Chrome or Edge.
- Sign in with your e-mail and password. If two-step sign-in is on, also enter the 6-digit code from your
  authenticator app. After 5 wrong passwords the account waits 15 minutes.
- **Search everywhere**: press **Ctrl K** (⌘K on a Mac) and type a page, a person, a door or a card number.
- **Your menu**: *Your account → Menu & appearance* — untick the pages you never use. They disappear from your menu
  only (they stay reachable with Ctrl K). "Visionline essentials only" keeps just the Visionline pages.
- **Light or dark**: the switch at the bottom of the menu (Automatic follows Windows), or *Your account → Menu &
  appearance*. Your choice follows you to any computer.
- **Help**: *Help and manual* at the bottom of the menu opens this manual.
- **Help on hover (2.29)**: rest the mouse on a menu item, a tab, a shortcut or a button: a short explanation of what it
  does appears, and goes as soon as the mouse moves away (or a key is pressed). Keyboard users get it on focus. Switch
  it off under *My account → Menu & appearance* (on that computer).

What you see depends on your role. A hotel administrator can also switch whole modules off (*Settings → Modules*), or
set **Portal focus: Visionline only**, which hides mobile keys, attendance, breakfast, battery and maintenance from
everyone except administrators.

## 2. Overview

The first page starts with **To do now**: only what is waiting for *you* (keycard requests to handle, lock-outs to
approve, departures to clear, keycards ending this week, an emergency), refreshed by itself, with quick actions below
it. Then today's figures and anything that needs attention. Click a card to open the page behind it.

## 3. Visionline cards & people

Everything Visionline knows about people and their keycards, read-only.

- **People**: every Visionline user (by user group), their valid keycards, doors, validity and who issued them.
- **Card lookup**: type a card number, or put the card on the encoder and press **Read card at encoder**: the portal
  shows whose card it is, its doors, validity, whether it can open the deadbolt, and the doors it opened recently.
  Reading at the encoder is limited to a few reads a minute so Visionline stays free for reception and the GRMS.
- Data is refreshed by *Insights* sync (*Settings → Reports & sync*). Choose **Only at night (22:00–06:00)** to keep
  Visionline free for the PMS and GRMS during the day.

## 4. Access history

"Which doors did this person open?" and "Who went through this door?".

1. Type a name, a door or pick from the suggestions.
2. Choose the period (7, 30, 90 days…).
3. Read the figures, the per-day chart, the doors list and the timeline. Click a door to see who else went through.

Only what the locks reported to Visionline is known. Offline locks report when a card that was there is used at an
online reader or when the lock is read.

## 5. Event log

Every lock event received from Visionline (entrances, refused entries, alarms, battery), every mobile-key event and
system events, with filters (period, type, door, person, known/unknown card). **Print** makes a PDF with a
fingerprint (SHA-256) that can be checked later under *Verify a PDF*: any change to the file shows.

### 5k. New in 2.27: Reports, the two setup reports, a shorter menu and French

**Reports** (menu → *Reports*) puts every report in one place. Choose a report on the left, then **Day** or
**Month** (yesterday and last month are one click away). Each report shows its figures, then the full list, and can
be **downloaded as a PDF** (fingerprinted, checkable under *Verify a PDF*), **downloaded for Excel (CSV)**, or
**e-mailed now** to one or more addresses (the PDF and the CSV are attached).

| Report | What it answers |
|---|---|
| Daily summary | Entrances, refused entries, guest and staff keycards issued, keycard requests, battery alarms, locks offline, open alarms, maintenance: one page per day or month |
| Guest keycards issued | How many guest keycards Visionline made, and in which rooms they were used; for a month, one line per day |
| Staff keycards issued | Every staff keycard made in the day or month: for whom, user group, card, who issued it, valid until, still working or not |
| Who holds staff keycards | Every valid staff keycard now: holder, user group, card and register number, doors, deadbolt override, valid until, who issued it, last used. Generic names in red; people with two cards or cards ending within 30 days in orange |
| Keycard requests and returns | New, replacement, return and cancellation requests, their state and who handled them |
| Door activity | For each door: entrances, refused entries, how many staff and guest keycards were used, last use |
| Refused entries | Every refused entry: when, door, card, whose, why |
| Locks and batteries | Battery alarms and changes, battery state now, how long the batteries have been in, locks offline |

*More reports* on the same page links to Insights, My charts, the printable Event log, Keycards per room, the
Accounts daily report and the two setup reports.

**E-mailed every day or every month** (administrators): under *Reports sent by e-mail*, choose the report, *Every day*
(the previous day, at the time you choose) or *Every month* (the previous month, on the 1st), and the addresses.
E-mail must be set up first (*Settings → Alerts & notifications*). *Stop* ends it. The Demo Hotel never sends any.

How guest keycards are counted: Visionline's live feed reports each keycard it makes; the report counts those that are
not staff keycards or mobile keys. A guest keycard made while the connector was off is counted when it is first used
at a door.

**Two setup reports** (*Administration → System setup reports*):

- **Visionline setup report**: Visionline only. Its first page, *At a Glance*, states plainly the **Visionline
  version**, whether **AES encryption is enabled**, the **number of locks** (online and stand-alone, by category and
  by door group), user groups, door groups, encoders, people and valid keycards, then the system code and ID, the
  Web API version, the firmware pack, the licensed options and the guest card defaults. The version and AES come from
  the Visionline **System settings report**: import it on the same page (*Import a Visionline report*). If the report
  does not mention AES, the page says so and where to check in Visionline, rather than guessing.
- **Portal setup report**: this portal only: its version, the connector, the Visionline operator the portal uses,
  the licence, who can sign in (with two-step sign-in or not), which person each Visionline operator is, keycard
  types and the portal parameters.

2.27.1: while the setup report is being prepared the page says so and counts the seconds. If it takes more than 90
seconds it says which step is slow and what the database is busy with, instead of staying blank. The portal setup
report is prepared on its own, so it shows even when the Visionline part is slow.

**Closing alerts (2.27.1)**: an alert closes by itself within a minute once the problem is fixed; the line under
each alert says how (door reports again, new batteries recorded, alarm completed in Visionline, connector back…).
**Mark as seen** (or **Mark all as seen**, for all or one type) says someone is handling it: it leaves the red count
in the menu and moves to *Seen*, still listed until fixed. Door-silence alerts can be switched off in *Settings →
Alerts & notifications*.

**AES key mode (2.28)**: the first page reads the *[Security enhancement process]* section that Visionline 1.28 or
newer writes in its System settings (ASSA ABLOY guide *Switch to AES key mode*, 66 5013 166-1B):

| Key mode in Visionline | First page shows | Meaning |
|---|---|---|
| Not started | Legacy key mode (red) | Keycards use the legacy key mode |
| In progress | In progress (orange) | AES site key generated; locks being updated and initialised; keycards still legacy |
| Finished | AES (finished) (green) | Visionline makes AES keycards; when the *Disable legacy key mode* card has been made it says so (locks stop accepting old cards once it is shown to each) |

*Known authentication information* (for example *Ultralight AES signature*) is listed separately as card
authentications Visionline can read: it is not the key mode. The *PMS encryption key* line belongs to the PMS
interface, not to the cards.

Also on the first page: **Clients allowed** (from the licence lines of the report), **Mobile key licence**
(Licensed, Demo or None, from the licensed options or a licence line that says demo / trial), **PMS interface**
(the PMS options and settings, and, when a card list with the operator was imported, how many keycards were made
through the PMS interface operator and when the last one was), and **DESFire EV1 enhancement**. When the report does
not contain one of these, the page says so: Visionline → *Help → About* / *Tools → Option code* show the licence.

**A shorter menu**: Overview, Reports and Alerts at the top, then four sections that open one at a time: *Doors &
safety*, *Keycards & people*, *Locks* and *Administration*. The section of the page you are on opens by itself; a
closed section shows a number when something inside needs attention (critical batteries, locks offline…).

**Languages**: **Auto**, English or Français, at the bottom of the menu and on the sign-in page. **Auto** (the
default, 2.27.1) follows the language of the browser, which normally follows Windows (*Settings → Time & language →
Language*; in Chrome or Edge, *Settings → Languages*): a computer set to French opens the portal in French. Choosing
English or Français keeps that language on this computer and with your account. The menu, sign-in page, overview, reports and feedback are translated; some detailed
pages are still in English and will follow.

### 5j. New in 2.26: reading a card at the encoder

Visionline does not use the same name for "read the card on the encoder" everywhere. When it answers *Invalid query
parameter value*, the connector (0.16.1) tries the other name once (reading changes nothing), and the platform keeps
the one that works (Settings → Reports & sync → Encoders). 2.26.1 (connector 0.16.2) also tries the encoder name
with its space written as "+" (for names such as "Encoder .96"), remembers the form that works for encoding too, and
when nothing works lists Visionline's answer to each form. If the connector on the Visionline server is older, the
message says so: install the latest installer with **Everything** (Connector health shows the connector's version).

### 5i. New in 2.25: Demo Hotel, testers and feedback

- **Feedback** (bottom right of every page): a few words and an optional 1–5 rating, with the page you were on.
- **Administration → Demo Hotel and testers** (platform administrators): a site with made-up data, one-time
  invitation links for testers with access for 1, 7 or 14 days, the testers' state, and all feedback (CSV export).
  Testers see only the Demo Hotel; nothing there is sent to Visionline. See TESTERS.md.

### 5h. New in 2.24: sign-in page and finding your way

- **Sign-in page:** the property's logo and name, a keycard held to a lock, what each team does in the portal, the
  notice board's public posts, and *Forgotten password or first time here?* (invitation link, password link from an
  administrator, two-step reset, the property's help contacts from Settings → Name & details). It works on phones too.
- **Overview shortcuts:** the everyday tasks this person may do, one tap away: verify or extend a keycard, look up a
  card, keycard request, unpaid guest, who is in the building, who opened a door, lock batteries, alerts.
- Each page has its own browser-tab title; *Skip to the page* for keyboard users; on a phone the menu is one list.
- On a public address (Cloudflare Tunnel) search engines are told not to list the portal (robots.txt and a no-index
  header), and the portal can be added to a phone's home screen.

### 5g. New in 2.23: Verify a keycard at an encoder and extend it

**Staff keycards → Verify & extend** (also on an issued request: *Verify this keycard at an encoder, or extend it*):

1. Place the keycard on an encoder, choose the encoder and press **Read the card**. Visionline itself answers: whose
   card it is (and its card number HK …), its doors and door groups, and whether it works and until when — or that it
   ended, was cancelled or replaced by a newer card. A card in a generic name is pointed out.
2. To give it more time: choose **180 / 360 / 730 days** or any date, and press **Extend to …** while the card stays
   on the encoder. The card is written again with the same holder, doors, door groups and time schedule; only the
   expiry date changes. The register and the request follow the new date (and the new Visionline card number).
3. A card that had **ended or was cancelled** can be made to work again the same way, after ticking the confirmation.

Visionline keeps one staff card per person: if the holder has another valid staff card, the portal says so before,
because that card stops working. Extending needs the right to issue keycards and encoding switched on (Settings →
Keycards & encoders); cards with door groups need connector 0.16.0 (in the 2.23 installer). Card lookup links to this
page ("Card in your hand?").

### 5f. New in 2.22: Verify a keycard

**Verify with Visionline** (Visionline cards & people → Card lookup) and **Verify keycard** (Staff keycards → a request
with a Visionline card number) ask Visionline *now* whether the card is valid, its end date and its doors. The lists in
the portal are read on request, so they can be older than Visionline; Verify reads only that card's holder (one person),
which is light for Visionline. The same card can be verified again after 30 seconds. A card that was never read from
Visionline cannot be verified by its holder: read it on an encoder (Card lookup) or press Refresh from Visionline.

### 5e. New in 2.21

- **"Issued from Visionline"** replaces "Visionline desk" for keycards made in Visionline. When the Visionline operator
  who made the card is known it is shown, with the person behind that operator: *Issued from Visionline · jdoe (John
  Doe)*. The operator is known when the card was recorded on the Staff keycards page (field *Visionline operator who
  made it*; empty = your own Visionline operator) or from a card log imported in the System setup report. The
  Visionline Web API itself does not say who made a card.
- **Who each Visionline operator is:** System setup report → Visionline Operators → *Who each Visionline operator is*:
  an administrator links each Visionline operator to a portal user. Users who saved their own Visionline sign-in are
  linked automatically.
- **Staff keycards record who issued them:** the requests list, the request page, the keycard register and its HR
  export show *Issued by* (the portal user), when, and how (encoded from the portal, issued from Visionline with the
  operator, or an existing keycard linked).
- **Battery alarm clears after 2 cards** accepted by the lock without the low flag (was 3).
- **Keycards in a generic name** are also e-mailed to the site's administrators (each card once), besides the warning
  in the portal and Monitoring.
- **Fewer false "Visionline cannot be reached" alarms:** see Monitoring, connector 0.15.0.

### 5d. New in 2.20

- **"Stale" is back** on Battery status for a lock not heard from for the number of days set in Settings.
- **How long each set of batteries lasted.** Battery status shows, per lock, how many days the batteries now in it have
  been in, how long the previous set lasted and the average over all sets; the lock's page lists every set (put in,
  taken out, days, days to the first low report). Lock troubleshooting shows the same from an uploaded report ("Sets
  lasted 5, 10 days").
- **A battery alarm clears itself after cards work normally.** When the lock accepts 3 cards in a row (staff or guest)
  without logging the low-battery flag again, the alarm and its request close by themselves — unless a voltage reading
  says the battery is at or below your threshold. Settings → Battery & maintenance (3 by default; 0 = off).
- **Visionline is read on request.** Doors, user groups, people and keycards are read when someone presses **Refresh
  from Visionline** (Visionline cards & people, Battery status, System setup report) — for example after lock data was
  uploaded to Visionline or its resources were refreshed — at most once every 5 minutes. Cards used at doors and battery
  reports still arrive as they happen. Settings → Reports & sync → *On a schedule* brings back regular reads.
- **Staff keycard expiry is a date.** The request form, the QR request page and the issue form have an **Expiry
  date**; the card works until the end of that day. Empty: the period set in Settings.
- **Keycards in a generic name** ("Staff", "HK 2", "Spare", a number…): listed under Staff keycards and announced to
  the administrators in Monitoring while any exist, because nobody can tell who used them.
- **System setup report:** *Worth a look* (rooms no user group opens, groups that open every room, deadbolt overrides,
  guest rooms opened by staff groups, generic keycards…), **User Groups vs. Rooms** (every room against every user
  group: ✓ directly, ◐ through a door group, and how many people can open it; filters on screen, everything on paper),
  and **System Parameters** taken from the Visionline System settings report.
- **Outside access without a public IP** through Cloudflare Tunnel and your own domain: see EXTERNAL-ACCESS.md.
  Invitations then come with an outside link too.
- **Security:** other sessions end when a password changes or two-step sign-in is reset; each two-step code works
  once; own passwords need 12 characters. See SECURITY-REVIEW-2.20.md.

### 5c. New in 2.19

- **A battery alarm after new batteries is a firmware fault.** If a lock raises a battery alarm (even once) within 14
  days (Settings → Battery & maintenance) after its batteries were changed, and its voltage readings since the change do
  not confirm low batteries, it is not a battery problem: no battery alarm and no "replace battery" request. The portal
  opens **Program the lock and upload firmware** instead, and notes it in the audit trail (`battery.firmware_suspected`).
- **3.6 V threshold.** On 3–4.8 V locks a reading of 3.6 V or lower is critical: a battery alarm and a "replace
  battery" request. Change it in Settings → Battery & maintenance.
- *(2.20 brought back the word "stale"; see 5d.)*
- **Lock troubleshooting** now asks which lock it is: the door (suggested from the file) and the **lock model**
  (VingCard Signature RFID, Essence, Classic RFID, Allure, or other), remembered for the door. The report says which
  door and model it is about, and warns when the file is about another room.
  - **Find the cause, step by step** (elimination method): batteries, battery holder and contacts, door and lock
    mechanics, how much the door is used, card reader, Bluetooth, online radio and gateway, door unit electronics,
    firmware, location and climate. Each step shows what the report says (likely / possible / unlikely / check on site)
    and what to check on the door; the technician marks it *OK, ruled out* or *Problem found*, with a note. A firmware
    fault can also drain batteries, so the other causes are ruled out first.
- **Online locks & gateways** (Building → Online locks & gateways): the locks Visionline runs online, whether each is in
  contact (with its last contact, gateway, lock model and battery), and the **gateways** with their **EEID**, address,
  location and the locks behind them. Administrators add gateways or import the list (a table with Name, EEID, IP /
  Address, Location, Doors). A gateway is offline when a Visionline alarm names it (its EEID, or its name with
  "gateway"/"offline"…) or when all its locks are offline. **Offline locks and gateways raise an alarm in Monitoring
  that closes by itself when they are back**; the page lists what came back. Live gateway state from the network
  integrator (Ruckus, Cisco…) will be added once their system can be read.

### 5b. New in 2.18

- **New batteries close the alarm by themselves.** Right after new batteries, a lock reads the top of its scale
  ("Battery level below 4.8 volts", or 9.0 V for 6–9 V packs). That reading now closes the battery alarm and resolves
  its maintenance request, and counts as a battery change. Settings → Battery & maintenance can switch this off.
- *(2.19 changed how battery alarms after new batteries and the "stale" wording are handled; see 5c.)*
- **Lock troubleshooting** (Building → Lock troubleshooting, or *Troubleshoot a lock* on Battery status), mainly for
  offline locks. It works whether or not battery monitoring is switched on.
  1. Read the lock with the service device and upload its events to Visionline as usual.
  2. In Visionline, open the lock's events and save them as a report (.xls), e.g. `1115.xls`. Both the older layout
     (Time, Event…) and the newer one (Door, S/N, Event time, Read-out time, Seq.No…) are read.
  3. Upload the file, check the newest events (switch *Day/month* if day and month are swapped), choose the door
     (suggested from the file) and confirm.

  The report starts with a verdict (*needs attention*, *a few things to check*, *nothing wrong found*) and **what to do,
  in order**, then every finding with its reason. It covers:
  - **Battery:** readings over time with each battery change; each battery period with days to 4.4 / 4.2 / 4.0 V,
    use per 30 days and per 1,000 openings, alarms; how long a set lasts at that rate; the alarms that count, and the
    low-battery alerts ignored after a change.
  - **Lock:** internal errors, card-reading and Bluetooth errors, cards of another system, restarts (those right after a
    battery change are normal and not counted), lost clock, data errors; a week-by-week table.
  - **Door:** left open too long (how often, how long), opened from outside with no card or key just before (latch
    not catching, or forced), mechanical key openings, deadbolt use, refused entries by reason.
  - **Use:** openings a day, by hour and by weekday, cards used by card type.
  - **Service and data:** service-device read-outs, time setting and program uploads with dates, server pings for
    online locks, and the report's own quality (rows read twice counted once, events with a lost clock, readings left
    out while the lock was being programmed).

  Every event type and every refusal reason is explained in plain words, for example:
  - *Door Unit Internal* events are the lock's own, mostly mechanical events (door opened or closed, double lock on or
    off).
  - *Deadbolt thrown / released*: the knob inside the room turned the double lock on / off.
  - *Error, Door unit dead bolted*: someone tried to open while the double lock was on; only cards with the right to
    override the deadbolt open the room then. Normal privacy, not a fault.
  - *Error, Card has expired*: an expired card was used; the door does not open.
  - *Mechanical key*: the metal key was used to open or lock the door.

  Refusals are shown as card or rights matters, not as lock faults.

  *Open a maintenance request* puts the findings into a request; *Print* makes a paper copy. Names, user IDs, card
  numbers and serial numbers in the file are not kept.

### 5a. New in 2.17

- **Name**: the product is now the *Access Monitoring Tool*. Staff mobile keys are an optional module, switched off
  by default (Settings → Modules).
- **Sign-in page** shows the notice board's public posts and good-practice reminders. **Notice board** (Overview):
  administrators post news, tips or important messages, with a picture, pinned or until a date; "also on the sign-in
  page" posts are seen before signing in (nothing confidential).
- **My charts**: anyone who can read some data builds charts (bars, columns, lines or a table) from door events,
  keycards, mobile keys, alarms, maintenance or breakfast, saves them, shares them and pins them to the Overview.
- **Mobile keys made in Visionline** are recognised: Visionline shows a phone's "card serial" as FFFFFFFF. They show
  as *Mobile key* in Visionline cards & people and in the reports.
- **Issued by**: every keycard encoded from this portal records the portal user. Cards made in Visionline
  show *Issued from Visionline* (2.21), with the operator and the person linked to that operator when known
  (recorded on the Staff keycards page, or a card list with the operator imported: System setup report → Visionline
  reports). When the Visionline user of the connector is a shared one (PMS /
  interface user), the portal warns: give people named Visionline operators.
- **Issuing a staff keycard**: choose the person already in Visionline (no duplicate), or *Existing keycard* to link
  a card the person already holds, with its user group.
- **Users and card holders**: operators sign in to the portal; card holders have keycards in Visionline; someone can
  be both. Users → *Link a card holder* shows their keycards; Visionline people show *Portal user*.
- **Encoder**: Card lookup always shows the encoder to read from (remembered on that computer), from Settings or
  read from Visionline.
- **System setup report**: Visionline system settings and operators (imported reports), the Visionline user the
  portal uses, access by user group and by person (filter by name, door or user group).

### 5b. Who can open a door, master keycards (2.16.1)

**Visionline cards & people → Keycards** has a simple filter: *Opens: <door>* lists every keycard (and its holder and
user group) that opens that door — for example the cashier door — counting the card's own doors, its door groups and a
uniform-access user group. Quick buttons: **Who has a master keycard** (opens every room), **Who can override the
deadbolt**, and *Who can open …* for doors such as the cashier, safe, stores or offices. Combine with a user group.

### 5c. Keycards per room (2.15)

**Keycards per room** (in the menu, under Event log) lists, for each guest room (or every door), the keycards that opened it or were
refused in a period: card number, type (mobile key, staff card, guest or other card), holder, **who issued it**,
entries, refused entries, first and last use. **Print PDF** makes the same fingerprinted PDF as the Event log.

*Issued by* shows the portal user for mobile keys and for keycards handled on the Keycards page (encoded at an
encoder from the portal or recorded there). Keycards made in Visionline show **Issued from Visionline** (2.21), with the
Visionline operator and the person behind it when known; the Visionline Web API does not tell who encoded a card. For a guest
card, the guest's name is shown when the day's in-house list (Breakfast import) has a stay in that room.

**Offline locks and offline systems.** A lock event reaches the platform when Visionline has it:
- *Online locks* report at once.
- *Offline (standalone) locks* keep their events in the lock's audit trail; they reach Visionline when the trail is
  read with the service tool (portable programming unit) or LockLink and uploaded. The platform files every event at
  the time the **lock** recorded it, so an upload done days later fills the right place in the history and in this
  report. Check once on site that Visionline reports uploaded audit trails to the Web API (read a lock's trail, upload
  it, then look for its entries here); if it does not, the Visionline desk report is the source for those locks.
- *If the platform or the connector is down*, Visionline keeps the changes in the connector's callback queue and the
  connector reads them back when it returns; nothing is lost while the queue holds them. Confirm the queue retention
  of your Visionline version for long outages.

## 6. Insights and your own reports

Management dashboards: people and keycards per group, key activity, refused entries, battery and alarms. Every chart
has a **Table** button. **Build a report** lets you choose what to count (entrances, refused, cards…), group by
(door, person, group, day…) and filter; save it under **My reports** and export CSV or PDF.

## 7. Live occupancy (security desk / fire warden screen)

Who is in the building **now**:

- **Staff on site**: people whose keycard or mobile key opened a door in the last hours (10 by default), plus people
  checked in at attendance and not checked out.
- **Guests in house**: rooms on today's in-house list (PMS report imported in Breakfast, or kept by front office),
  with the number of guests and names. Hotels that do not use the restaurant screen switch Breakfast on only to keep
  this list.
- **Other rooms opened**: room doors opened recently with a card that is not on the list.

Put it on a dedicated screen: sign in with an account that has the role **Safety / fire warden** (it sees only this
page and Emergency), open *Live occupancy* and press **Full screen**. It refreshes every 20 seconds.

**Print evacuation list** gives a PDF with every room in house and every person on site, with a tick column.

Locks record who **enters**, not who leaves. Use the screen as the starting point of the sweep, not as proof that an
area is empty. The time windows are set in *Settings → Safety & emergency*.

## 8. Emergency

1. **Start**: choose Fire, Evacuation, Drill or Other, describe what and where, press **Start**, re-enter your password.
2. **Confirm**: a second person with emergency rights opens *Emergency* and presses **Confirm emergency** (password
   again). Two people are always needed; one person cannot confirm their own request.
3. **Roll call**: on *Live occupancy*, click each room and tick each person as safe. The banner counts how many are
   accounted for. The evacuation list PDF marks them SAFE.
4. **Emergency keys** (not during a drill): choose responders whose phone is set up; they receive a mobile key with the
   emergency template for a few hours. The two-person confirmation counts as the approval for broad access.
5. **End**: write a note (for example "all clear from the fire brigade") and press **End emergency**.

Everything is in the audit trail with names and times.

**Opening all guest rooms at once (2.14)**: during a confirmed emergency (not a drill), *Emergency open all guest
rooms* sends the Visionline emergency-open command to every guest room with an **online** lock; the page shows which
locks answered, and *Back to normal* (also automatic when the emergency ends) returns them to normal. Rooms with
**offline** locks are listed: use the **emergency card** (encode one in *Staff keycards → Encoders & special cards*;
it opens every lock, also with the deadbolt on). Switch the command on in *Settings → Safety & emergency* after
testing it on one door.

## 9. Staff ID cards

A profile per person — photo, full name, ID number, department, job title, validity — printed on the keycard
(CR80, 85.6 × 54 mm) with any card printer, or on paper for a badge sleeve. The barcode holds the ID number, so
attendance desks and canteen tills can scan it with a USB scanner.

- **Create from…**: make profiles for Visionline people (by user group), the attendance list or mobile-key staff in
  one go. Profiles that already exist are not duplicated.
- **Photo**: open a profile, **Use camera** (webcam at the desk) or **Choose a picture**. It is cropped to 3:4 and kept
  small (under 300 KB). Plain light background, face centred.
- **Print**: tick the people, **Print cards**; choose the card printer, **actual size / 100 %, no margins**. Tick *Print
  the back as well* with a duplex printer. After printing, confirm, and the print count is recorded.
- **Layout**: *Settings → ID card layout* (portrait or landscape, title, what is shown, the text on the
  back, the safe margin for the printer).

Printing does not touch the chip: print before or after encoding the card in Visionline.

**Recommended printers**

| Use | Printers |
|---|---|
| RFID keycards (best: prints on film laid on the card, edge to edge, not spoiled by the chip) | HID Fargo HDP5000 / HDP6600, Evolis Avansia, Matica MC310, Entrust Datacard CR805 |
| Flat PVC keycards, lower cost (direct-to-card; keep a 1–1.5 mm margin) | Zebra ZC300 / ZC350, Evolis Primacy 2, Magicard Rio Pro 360, HID Fargo DTC1500 |

Ask your card supplier for a printable surface version of your keycard (some glossy cards do not take
ink well).

## 9b. Staff keycards (requests, register, cancellations)

*People & keys → Staff keycards.* Visionline stays the key system: every card is made in Visionline, either encoded
from the portal at an encoder or issued from Visionline and recorded here, with who issued it.

- **Request**: *New request* (or the **QR code page**: front office prints the QR code from *QR code page*; managers
  scan it with their phone, no sign-in). Choose New / Replacement / Cancellation, permanent or daily staff, first name,
  surname, department, job title, employee number, card number (e.g. **HK 001**), the manager asking (e.g. the
  Housekeeping manager), HR e-mail, reason. Daily staff can ask for several cards at once.
- **Issue**: open the request, choose the Visionline user group and validity. *Encode here*: place a blank card on the
  chosen encoder and press *Encode the card* (the person is created in Visionline if needed). *Issued from
  Visionline*: record the Visionline card number and the Visionline operator who made it (empty = yours). Permanent staff need the card number (HK 001); it goes into the
  **Register**.
- **Resignation / cancellation**: open the request, say whether the card was returned, lost or damaged, and stop it:
  *Overwriting it at the encoder* (the returned card is rewritten so it expires one minute later), *Cancelling its
  number in Visionline*, or *Done in Visionline*. HR and the security manager receive an e-mail ("keycard
  cancelled and returned").
- **Send to HR** e-mails one request; **Register → Export for HR** gives the whole list (CSV).
- **Renewals & duplicates**: staff keycards ending within 7/30/60 days (also on *To do now*, and once a day an e-mail
  to HR and the security manager lists the cards ending within 14 days), and people holding more
  than one valid card. A *Replacement* request encodes the new card with *override*, which cancels every older card of
  that person in Visionline.
- **Unpaid guests**: front office asks (room, guest, amount, reason); a manager approves (never the same person).
  Online lock: the Visionline checkout command stops the guest's cards at the door. Offline lock: a one-minute guest
  card is encoded for the room with *override*; place it in the lock and the guest's cards stop working. Every case is
  listed (and in the Accounts report). *Settled* closes it; issue a new key in Opera.
- **Departures**: rooms leaving today. Online locks: *Send checkout* and see which locks confirmed it. Offline locks:
  place the **clearance card** on the lock and tick *Clearance card placed*.
- **Encoders & special cards**: the encoders read from Visionline and their last use; encode **emergency**,
  **stand-open**, **clearance** and **one-time** cards. Choose the encoders the portal may use in *Settings →
  Keycards & encoders*.

## 9c. Reports for Accounts and the system setup report

- **Accounts daily report** (*Settings → Accounts daily report*): an e-mail every morning with the guests who checked
  in yesterday, the guests in house and the number of occupied rooms (to tally with the Opera night audit), the
  **rooms with more than one active guest keycard** (read from Visionline 30 minutes before the report; a room not on
  the in-house list is flagged), and the unpaid-guest lock-outs. *Send now* sends it at once; the page shows a preview. It reads the Opera in-house list
  imported in Breakfast.
- **System setup report** (*Administration → System setup report*): property, keycard types, user groups, door groups
  and rooms, locks (online/offline), time tables, who has access, and the main parameters — one section per page, in
  the layout of the Visionline System Setup Report. *Print / PDF*.

## 10. Staff and mobile keys (when the module is on)

- **Staff**: people who can receive a mobile key, their phone set-up (invitation code in the staff app) and their key.
- **Issue a key**: choose the person, a template or doors, the validity; broad access needs a second person's
  approval. The key appears in the phone within a minute; **Revoke** removes it.
- Visionline allows one staff mobile key per person. **Change doors** replaces a live key.

## 11. Time & attendance, Breakfast, Battery, Maintenance

- **Time & attendance**: door entrances at attendance doors, the check-in desk and HR corrections become timesheets
  and payroll exports. The ID card barcode can be used at the desk.
- **Breakfast**: the day's in-house list (import the PMS report), restaurant check-off by room, the day sheet.
  The same list feeds Live occupancy.
- **Battery status**: lock battery levels and alarms from Visionline; low batteries become maintenance requests.
  - **Batteries last changed** (2.15) is shown per lock: from the lock's *Battery exchanged* event, or — because that
    event is rare in the logs — from an abrupt rise in the lock's voltage readings (for example *below 3.6 V* followed
    by *below 4.6 V*; the jump is set in *Settings → Battery*, default 0.8 V), or from a maintenance request resolved
    as "battery replaced".
  - **Batteries changed, lock still alarming** (2.15): if a lock reports a battery alarm within 14 days of a battery
    change, the platform opens a high-priority maintenance request *"Program lock and upload firmware"* instead of
    another battery request. Program the lock and upload its firmware with the service tool, then check the alarm
    clears. Replacing batteries in good time, before they are critically low, avoids this.
- **Maintenance**: requests from the portal, the staff app and battery alarms, assigned to technicians.

## 12. Administration (administrators only)

- **Users** (2.16, was *Operators*): **Invite someone** — name, work e-mail and what they do (Administrator, Front
  office, Security manager, Department manager, Management, Maintenance manager, HR, Safety, Auditor; or *Choose roles
  instead*). The person gets a one-time link (72 hours, also by e-mail when e-mail is set up), chooses their own
  password and is signed in. **New link** for an expired invitation, **Password link** for a forgotten password (your
  password is asked first), **Remove** to take away access. *Add with a password* still works. Also: modules per
  person (presets *Visionline only* / *Show everything*) and *Reset two-step* when someone lost their phone. Roles:
  Administrator, Security Manager, Key Issuer, Approver, Maintenance Manager, Technician, Management (reports), HR
  Manager, Timekeeper, Restaurant, Safety / fire warden, Department manager, Auditor, Read only.
- **Hotel or institution** (2.16): *Settings → Name & details → Type*. An institution does not see the guest
  features (Breakfast, Unpaid guests, Departures, the Accounts report) and the portal says "rooms", not "guest rooms".
- **Connector on another computer** (2.16): *Settings → Connector*. Choose *On another computer*, enter the
  connector computer's address, this server's address as that computer reaches it, and the Visionline Web API
  address. The page writes the commands: `set-connector-access.ps1 -Allow <address>` on this server (only that
  address may use the connector entrance; it saves the server certificate `gateway.cer`), then on the connector
  computer `visionline-probe.ps1 … -SaveCert` and `install.ps1 -PlatformUrl … -PlatformCaFile .\gateway.cer
  -VisionlineUrl … -CaFile …` with a token made on the same page. The connector list shows where each connector
  reports from. Both certificates are checked; nothing opens to the internet.
- **Getting started** (2.16): on the Overview, administrators see the first steps until they are done.
- **Menu** (2.16.1): click a group title (Safety, People & keys, Building, Administration) to fold it away; the
  choice is remembered on that computer. The menu scrolls when it is longer than the screen.
- **System setup report** (2.16.1): the user groups table shows *Override deadbolt* and *Override privacy*
  (Visionline user group settings) and how many valid keycards of each group override the deadbolt. Run resource
  discovery once with connector 0.13.1 to fill it.
- **Settings**: use the search box at the top to find a setting. Every save is a new version you can restore.
  - *Safety & emergency*: on-site windows, visitor groups, floors, emergency key template and duration.
  - *ID card layout*: orientation, title, fields, back text, printer margin.
  - *Privacy & retention*: how many days lock events, guest lists and usage counts are kept.
  - *Administrator protection*: **Require two-step sign-in for administrators** — Settings, Operators, Branding and
    the connector stay closed to an administrator until two-step sign-in is on.
  - *Licence*: the installation ID and the licence key.
- **Usage**: who uses the portal and what it did (keys, lookups, reports, records), with an estimate of the time saved
  (minutes per item are editable). **Summary for the supplier** downloads an anonymous signed summary (counts only).
- **Audit trail**: every change with name and time, chained so that edits or deletions show.

## 13. Licence

The portal shows a reminder before the licence ends and a window to enter the new licence when it has ended. Paste the
key (or open the `.smklic` file) and press **Install**. Until then, after 14 days of grace, changes pause; signing
in, revoking keys, reading reports, Live occupancy and Emergency keep working.

## 14. Sharing Visionline with the PMS and GRMS

The portal is a well-behaved Visionline client:

- At most 2 requests at a time to Visionline (setting `VL_MAX_CONCURRENT` on the connector); key and card work goes
  first, background reads wait.
- When Visionline answers slowly or says it is busy, background reads pause for 30 seconds.
- Full reads of people and keycards can run only at night.
- Encoder reads are limited to a few a minute.

## 15. Security

- Passwords are stored as salted scrypt hashes; sign-in takes the same time whether or not an account exists.
- Visionline and Credential Services passwords are encrypted in your browser for the connector and never shown again.
- Sensitive actions (emergency) ask for the password again. Administrators can be required to use two-step sign-in.
- Every answer from the server carries browser protections (no framing, no sniffing, strict content policy).

## 16. When something does not work

| You see | Do this |
|---|---|
| "Connector offline" | On the Visionline server: Windows *Services* → *Access Monitoring Tool Connector* → Start. |
| Card lookup shows nothing | *Settings → Reports & sync*: is reading people and keycards on? Wait for the next sync or press Sync now. |
| Live occupancy has no guests | Import today's in-house report (Breakfast → Import). |
| "Two-step sign-in is required" | *Your account → Two-step sign-in*, scan the code, enter it, sign in again. |
| "Licence required" | *Settings → Licence*, enter the new key from your supplier. |
| ID cards print too small or off-centre | Print window: actual size / 100 %, margins none, paper size = the card printer's CR80. |
