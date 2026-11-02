# Live occupancy, emergencies and staff ID cards (2.13)

## Live occupancy (fire-warden / security-desk screen)

**Who counts as in the building**

| Group | Source | Leaves the count |
|---|---|---|
| Staff | A door opened with their keycard or mobile key in the last *N* hours (default 10), or checked in at attendance | After *N* hours, or when they check out at attendance |
| Visitors / contractors | Same, for the Visionline user groups listed as visitors | Same |
| Guests | Rooms on today's in-house list (PMS report imported in Breakfast, or front office; switch Breakfast on just for the list if the restaurant does not use it) | When the stay ends or is checked out |
| Other rooms | Room doors opened with a card not on the list in the last *M* hours (default 12) | After *M* hours |

Locks record entries, not exits, and offline locks report late. The screen is the **starting point of the sweep**.

**Set up the screen**: Operators → Add operator → role *Safety / fire warden* (sees Live occupancy and Emergency
only) → sign in on the PC by the security desk → Live occupancy → **Full screen**. It refreshes every 20 seconds.

**Settings → Safety & emergency**: the hour windows, floors (first digits of the room number; automatic by default),
visitor groups, the emergency key template and how long emergency keys last.

## Emergencies

1. One person starts it (Fire / Evacuation / Drill / Other) with the reason; a **second person confirms** it. Both
   re-enter their password (and code). One person cannot confirm their own.
2. Roll call on Live occupancy: click rooms and tick people as safe; the banner counts them; the evacuation list PDF
   prints them as SAFE.
3. Emergency mobile keys for responders (staff with a phone set up): the chosen template, valid a few hours; the
   two-person confirmation is the approval. Not during a drill.
4. End with a note. Everything is in the audit trail.

The live list, the PDF and the roll call work also when the licence has ended.

**Opening all guest rooms at once** is not offered: it is not part of the Visionline Web API the platform uses, and
standalone (offline) RFID locks cannot be opened remotely by any system. With online locks, ask ASSA ABLOY what its
online system offers. Keep **emergency keycards** (they open every lock, also with the deadbolt on) in the fire box and
at reception; *Emergency → Readiness* counts the valid ones Visionline reports (user group or type containing
"emergency").

## Staff ID cards

A profile per person: full name, ID number, department, job title, valid until and a photo (JPEG, cropped 3:4, under
300 KB; webcam or file). Profiles are created one by one or **from Visionline people, the attendance list or the
mobile-key staff** (no duplicates). The ID number is printed as a **Code 128 barcode** for attendance desks and canteen
tills (any USB barcode scanner).

**Printing**: tick people → *Print cards* → in the print window choose the card printer, *Actual size / 100 %*, margins
*None*, paper *CR80* (85.6 × 54 mm). Duplex printers can print the back too. After printing, confirm, and the copy
number is recorded (audit trail *idcard.printed*). Layout (portrait/landscape, title, fields, back text, safe margin)
in *Settings → ID card layout*; the logo comes from *Branding*.

**Recommended card printers**

| Kind | Models | Why |
|---|---|---|
| Retransfer (best for RFID keycards) | HID Fargo HDP5000 / HDP6600, Evolis Avansia, Matica MC310, Entrust Datacard CR805 | Prints on a film then fused to the card: even over the chip and antenna bump, edge to edge |
| Direct-to-card (lower cost) | Zebra ZC300 / ZC350, Evolis Primacy 2, Magicard Rio Pro 360, HID Fargo DTC1500 | Flat PVC cards; set a 1–1.5 mm safe margin |

Use printable keycards (ask ASSA ABLOY / the card supplier for a printable PVC surface). Printing does not touch the
chip: print before or after encoding in Visionline. Card printers come with Windows drivers; any of them appears in
the browser's print window.

## Towards issuing staff keycards from the portal

Today Visionline encodes staff keycards and the portal issues staff **mobile** keys through Visionline. The way to
replace Visionline's staff screens for day-to-day work, step by step:

1. **Done**: people and keycards read from Visionline, card lookup, reading a card at the encoder (pilot), staff
   mobile keys, ID profiles and printing, attendance.
2. **Next (needs ASSA ABLOY)**: encode a staff keycard at an encoder from the portal (Visionline Web API
   `POST /cards?action=encode&encoder=…`; the exact body and the licence options must be confirmed by ASSA ABLOY and
   tested on a non-production Visionline). The portal would then encode the card, print it, and record both in one step.
3. Then: change doors / extend validity / cancel a staff keycard from the portal, with the same approvals as mobile keys.

Each step is switched on per hotel and tested on site first; the Marriott Visionline on the development PC stays
read-only.
