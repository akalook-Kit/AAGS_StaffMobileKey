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

**Opening all guest rooms at once (2.14)**: online locks receive the Visionline `emergencyOpen` command (Web API
§5.13.4) from *Emergency → Emergency open all guest rooms*; offline locks need the emergency card (Web API §7.22.2),
which can be encoded from *Staff keycards → Encoders & special cards*. The readiness panel counts online and offline
guest-room locks.

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

Use printable keycards (ask the card supplier for a printable PVC surface). Printing does not touch the
chip: print before or after encoding in Visionline. Card printers come with Windows drivers; any of them appears in
the browser's print window.

## Issuing staff keycards from the portal (2.14)

Staff keycards are requested (portal or QR code page), then encoded at an encoder from the portal through the
Visionline Web API (`POST /cards?action=encode&encoder=…`, §7.6.1) — so the card exists in Visionline exactly as one
made at the desk — or made at the Visionline desk and recorded. See USER-MANUAL.md, "Staff keycards".
