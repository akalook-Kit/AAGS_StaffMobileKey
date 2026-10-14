# Event log and printed reports (release 2.6)

**Event log** (portal menu) lists everything that happened at the doors and in the platform, newest first, in
hotel time.

## Three views

| View | What it contains |
|---|---|
| **All events** | Everything below, including card changes and the life cycle of mobile keys |
| **Entrance events** | Doors opened: lock reports "card accepted" (Visionline event 64 by default) and the first use of a mobile key at a door (from ASSA ABLOY) |
| **Error events** | Errors and warnings: refused entries (no access to this room, card expired, card cancelled, ...), open Visionline lock alarms, battery low/critical, keys that could not be issued or removed, connector tasks that failed |

Each event has a type, so the selection can be narrowed further:

| Type | Source | Severity |
|---|---|---|
| Entrance | Lock (Visionline), mobile key first use (ASSA ABLOY) | info |
| Refused entry | Lock (Visionline): events 320, 322, 323, 325, 327, 368, 369, 53 | error |
| Lock alarm | Visionline alarms (Insights directory read) | error while open, warning once confirmed |
| Battery | Lock (Visionline): low = warning, critical = error, exchanged/readings = info | |
| Card change | Visionline: card cancelled/discarded = warning; overridden, expired = info | |
| Mobile key | Platform: issued, removed, expired, replaced = info; could not be issued/removed = error; wrong-door limit = warning | |
| System error | Connector tasks that failed or got no answer | error |

**Selection:** period (Today, last 24 h, 7 days, 30 days, or any from/to up to 366 days), event types, one door,
and a person, card number or text. Errors carry the word *Error* or *Warning* next to the colour, so they can be
told apart without colour.

## PDF only - and checkable

The event log cannot be exported to a spreadsheet. **Print PDF** asks the platform to make the PDF:

- A4 landscape; on **every page**: hotel logo, hotel name, report title, the hotel's **system number** and the
  **Staff Mobile Key version** at the top; report ID, who printed it, page *n of N* and the hotel's footer line at
  the bottom. Page 1 also states the selection and the totals.
- Up to 5,000 events per PDF (the PDF says so if the selection had more).
- Every PDF is recorded with the SHA-256 fingerprint of its exact bytes, and the print is written to the audit
  trail.

**Verify a PDF** (same page): choose a PDF file; the browser computes its fingerprint (the file is not uploaded)
and the platform answers *Genuine and unchanged* (with who printed it and when) or *Not confirmed*. Changing even
one character in the file - a name, a time - makes the check fail. This makes the PDF tamper-evident; it cannot
stop someone from editing a copy, but the edit is detected.

Note: the PDF uses the standard PDF fonts. Latin letters with accents are printed (é, ç, ø, ɛ -> e ...); letters
of non-Latin scripts are shown as "?".

## Who can see it

Hotel Administrator, Security Manager, Auditor and Hotel Management (reports). Not technicians, key issuers or
read-only accounts.

## Door entrances need the connector's Visionline watch

Refused entries and battery events were already received by the connector's Visionline watch. From connector
0.7.0 the watch also asks Visionline for the **entrance event codes** in **Settings -> Event log** (default 64,
"staff card accepted", Web API §7.14.1). Add the codes of other accepted cards from the hotel's lock
documentation, or switch entrance recording off. The connector picks up a change within a few minutes (it
replaces its Visionline callback). A connector installed with `-NoWatch` records no lock events at all.

## Report header on other printed pages

**Insights -> Print / PDF** (printed by the browser) repeats the same header on every page: logo, hotel name,
report title and period, system number, version, printing time. The logo size for reports is set in
**Branding and logo -> Logo size -> Reports and PDFs**; the system number, legal name and footer line in
**Settings -> Hotel details**. A WebP logo cannot be placed in a PDF made by the platform - use PNG or JPEG.
