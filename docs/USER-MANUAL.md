# Staff Mobile Key — user manual (2.13)

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

What you see depends on your role. A hotel administrator can also switch whole modules off (*Settings → Modules*), or
set **Portal focus: Visionline only**, which hides mobile keys, attendance, breakfast, battery and maintenance from
everyone except administrators.

## 2. Overview

The first page: today's figures and anything that needs attention (keys waiting for approval, critical alerts,
batteries, open maintenance requests). Click a figure to open the page behind it.

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

**Opening all guest rooms at once** is not offered: it is not part of the Visionline interface the portal uses, and
standalone (offline) RFID locks cannot be opened remotely by any system. If your hotel has online locks, ask ASSA ABLOY
whether its online system offers it. Keep **emergency keycards** (they open every lock, also with the deadbolt on)
in the fire box and at reception; the Readiness panel counts the valid ones Visionline reports.

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

Ask ASSA ABLOY or your card supplier for a printable surface version of your keycard (some glossy cards do not take
ink well).

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
- **Maintenance**: requests from the portal, the staff app and battery alarms, assigned to technicians.

## 12. Administration (hotel administrators only)

- **Operators**: portal accounts, roles, modules per person (presets *Visionline only* / *Show everything*), and
  *Reset two-step* when someone lost their phone (your password is asked). Roles: Hotel Administrator, Security Manager, Key Issuer,
  Approver, Maintenance Manager, Technician, Hotel Management (reports), HR Manager, Timekeeper, Restaurant, Safety /
  fire warden, Auditor, Read only.
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
| "Connector offline" | On the Visionline server: Windows *Services* → *Staff Mobile Key Connector* → Start. |
| Card lookup shows nothing | *Settings → Reports & sync*: is reading people and keycards on? Wait for the next sync or press Sync now. |
| Live occupancy has no guests | Import today's in-house report (Breakfast → Import). |
| "Two-step sign-in is required" | *Your account → Two-step sign-in*, scan the code, enter it, sign in again. |
| "Licence required" | *Settings → Licence*, enter the new key from your supplier. |
| ID cards print too small or off-centre | Print window: actual size / 100 %, margins none, paper size = the card printer's CR80. |
