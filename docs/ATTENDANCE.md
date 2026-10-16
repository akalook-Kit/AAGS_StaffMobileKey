# Time & attendance (release 2.8)

Switch it on in **Settings → Modules → Time & attendance**. The menu item **Time & attendance** then has:

| Tab | For | What it does |
|---|---|---|
| **Check-in desk** | Timekeeper, HR | Everybody expected today with their state (In, Checked out, Not in yet, On leave). Search, then **Check in** / **Check out**. HR can enter **another time** with a reason. Refreshes every 30 seconds. |
| **Timesheets** | HR, management, auditors | One line per person for a week / month / any period: days present, absent, on leave, days without check-out, hours worked, overtime, lateness. Click a person for each day and every clock record; HR adds a missing record or **voids** a wrong one (with a reason - nothing is ever deleted). |
| **People** | HR | Who is recorded: **Add staff** (the Staff list, with their Visionline user), **Add Visionline keycard holders** (from Settings → Reports & sync), and **Add a person without a card** (daily workers, casual staff). Payroll number, department, job title, employment (permanent, contract, casual/daily, intern), paid monthly/daily/hourly, shift, keycard, start and leaving dates. |
| **Shifts** | HR | Start, end (a shift ending earlier than it starts runs past midnight), break, "late after" grace, working days. |
| **Leave & holidays** | HR | Annual leave, sick leave, days off, unpaid leave per person; public holidays for everybody. |
| **Payroll** | HR, management | Totals for the period and the exports: **Summary per person (CSV)**, **Day by day (CSV)**, **Summary (JSON)** for a payroll system, **Print PDF** (hotel header on every page, verifiable). **Approve this period** locks it: no record, leave or correction can change inside an approved period until HR **re-opens** it with a reason. |
| **Setup** | HR | Attendance doors and the rules below. |

## Where the times come from

1. **Attendance doors** (Setup): an entrance at, e.g., the staff entrance with a **keycard** or a **mobile key** is a clock
   record for the card holder. The first record of the day is the arrival, the last the departure. Passing the
   door again within 10 minutes is ignored. Needs the connector's Visionline watch with entrance recording on
   (Settings → Event log) and, for Visionline keycards, the person linked to the keycard holder (People → Edit, or
   "Add Visionline keycard holders").
2. **Check-in desk**: the timekeeper checks people in and out - this is how **people without a keycard** (daily
   workers) are recorded, and anybody whose card did not work.
3. **HR corrections**: a missing check-out, a forgotten day - always with a reason, kept with the record and in the
   audit trail.

## How a day is counted

- A working day starts at 04:00 (Setup), so a night shift counts on the day it started; for a shift that runs past
  midnight the day changes in the middle of the time off (22:00-06:00 → 14:00).
- **Worked** = departure - arrival (door records) or the sum of in → out pairs (desk/HR), minus the shift's break
  (or 60 minutes when there is no shift and more than 6 hours were worked), rounded if set (Setup).
- **Late**: arrival after shift start + "late after" minutes, counted from the shift start. **Early leave**: before
  the shift end. **Overtime**: above the shift's planned time, or above 8 hours without a shift (Setup).
- **Absent**: a working day of the person's shift with no record, no leave and no holiday (not before their start
  date, not after their leaving date; today only counts tomorrow). **No check-out**: an arrival without departure
  - fix it before approving.

## Exports for payroll

Daily rows: `employee_no, name, department, employment, pay_basis, date, shift, status, absence, first_in, last_out,
worked_hours, regular_hours, overtime_hours, break_minutes, late_minutes, early_leave_minutes, records, sources`.
Summary rows: `employee_no, name, department, employment, pay_basis, days_present, days_absent, days_leave,
public_holidays, days_without_checkout, worked_hours, regular_hours, overtime_hours, late_days, late_minutes,
early_leave_minutes`. Hours are decimal (7.50 = 7 h 30). CSV is UTF-8 with BOM (opens in Excel), formula-safe.
JSON: `GET /api/v1/hotels/{hotel}/attendance/export/daily.json?from=YYYY-MM-DD&to=YYYY-MM-DD` (signed-in user with
the attendance read right) - for a later direct link to the payroll system. Every export is in the audit trail.

## Roles

| Role | Desk | Timesheets & payroll | People, shifts, leave, corrections, approval, setup |
|---|---|---|---|
| Hotel Administrator | yes | yes | yes |
| **HR Manager** (new) | yes | yes | yes |
| **Timekeeper** (new) | yes | no | no |
| Hotel Management, Auditor | no | read | no |

## Hiding modules from people (2.8)

**Operators → Modules** (per person): tick a module to hide it - mobile keys, Insights, Event log, Monitoring, Time
& attendance, Battery, Maintenance, Audit trail. It leaves their menu and the server refuses its pages too; untick to
show it again. **Settings → Modules → Mobile keys module visible to → Hotel administrators only** hides mobile keys
(keys, staff phones, app settings and the key settings tabs) from everyone except hotel administrators while the
hotel finalises them.
