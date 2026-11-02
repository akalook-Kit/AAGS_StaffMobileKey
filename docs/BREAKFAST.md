# Breakfast (2.11)

The restaurant sees who is in house today and whether breakfast is in their rate, and records each room as the guests
arrive. Managers get the day sheet, the "not come" list and a CSV for F&B and night audit.

Switch it on in **Settings → Modules → Breakfast** (Hotel Administrator). It appears in the menu for roles with
breakfast rights.

## Who can do what

| Role | See | Serve (restaurant) | In-house list, settings, older days |
|---|---|---|---|
| **Restaurant (breakfast)** (new role for waiters / hostess) | yes | yes, today only; undo own entries for 15 minutes | no |
| Key issuer / supervisor, Hotel Administrator | yes | yes | yes |
| Hotel Management, Auditor | yes (and reports) | no | no |

A Restaurant user sees only the Breakfast page and lands on it after signing in. Create them in **Operators** with the
role *Restaurant (breakfast)*.

## The in-house list

Each stay has room, guest name, adults, children, arrival, departure and "breakfast included". A guest is in house on
a day if arrival ≤ day < departure (they have breakfast on the morning after each night).

- **Import from the PMS** (Breakfast → In-house list): export the PMS "in-house guests" / "arrivals" report as CSV and
  choose the file. Columns are recognised by name (room, name, adults, children / pax, arrival, departure, board /
  rate / breakfast, reservation / confirmation number) and can be corrected before importing. Board values such as
  `BB`, `HB`, `FB`, `AI`, `yes`, `1` mean breakfast included; `RO`, `no`, `0` mean room only.
- Rows with a reservation number update the same stay when imported again (no duplicates).
- **Replace today's list** (tick box): the file is the complete in-house list. Stays not in it are taken off the list
  from that day (moved, cancelled, left early). Importing the morning report daily keeps the list exact.
- **Add by hand** for walk-in check-ins; **Left** takes a room off the list from today.
- Room numbers that are not doors in Visionline are pointed out (typing mistakes in the PMS export).

## At the restaurant

Type the room number or guest name. Each room card shows guests, how many are in the rate and how many were served:

- **+1** / **All N** — served, in the rate.
- **+1 paying** — breakfast not in the rate, or more people than the rate covers (charged to the room / paid).
- A guest without a room (visitor, day guest): **walk-in** with a note.
- Serving more than the rate covers as "in rate" is refused; the restaurant records the extra people as paying.
- Mistakes are undone with **Undo** (with a reason). Nothing is deleted: undone entries stay visible.

The breakfast day starts at 03:00 by default (an entry at 01:30 belongs to the previous day), in the hotel's time zone.

## Reports

- **Today**: rooms in house, breakfasts in the rate served, not come yet, paying / walk-in, room by room.
  **Print day sheet (PDF)** — signed like the other reports (fingerprint in the audit trail).
- **Reports**: any range up to 62 days, per day: expected, served, not come, paying; rooms that never came.
  **CSV** with one line per room per day for F&B or the PMS.

## Settings (Breakfast → Setup)

Breakfast day starts at (03:00), service hours (06:00–10:30, shown to the restaurant), count children (on), allow
paying / walk-in guests (on).

## Privacy

Only room, guest name, number of guests, dates and board are kept — no e-mail, phone, passport or payment data. Every
import, change, undo, export and printed sheet is in the audit trail.

## Later

A direct PMS interface (instead of CSV) can feed the same list (`source = pms`); the platform's own port no longer
clashes with the PMS interface port 4000 (2.11 moved it to 47300).
