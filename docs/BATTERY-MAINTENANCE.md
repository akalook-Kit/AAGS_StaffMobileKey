# Phase 2: lock battery monitoring and maintenance requests

Both are hotel modules. They stay hidden until an administrator switches them on under
**Settings → Modules**.

- **Battery monitoring** needs connector **0.5.0 or newer** with its Visionline watch on. The platform
  checks this when the module is switched on.
- **Maintenance requests** has no other requirement.

## Where battery information comes from

The Visionline Web API has **no "battery level" query**. The only documented source is the locks' own
events, which reach Visionline and are read by the connector's watch (`/callback`, Web API §7.14.1):

| Events | Meaning on the platform |
|---|---|
| 304 battery low · 306 IR battery low · 529 battery alarm in lock · 533 backup battery low | **Low** |
| 305 critically low · 307 IR critical · 530 / 532 status changed to *Access Denied* · 531 IR alarm · 534 backup critical · 53 access denied due to battery alarm | **Critical** |
| 528 battery exchanged · 535 IR battery exchanged · 536 backup battery exchanged | **Good**. The open alert and its request are resolved automatically. |
| 1056–1081 "Battery level below X volts" (6.0–9.0 V and 3.0–4.8 V, in 0.2 V steps) | A **reading**. It becomes Low or Critical only if the hotel sets voltage thresholds (Settings → Battery & maintenance). |

Every door the platform knows is shown, including doors that have **never reported**. A reading becomes
**stale** after the number of days set by the hotel (30 by default).

> **Offline locks** (all 449 doors at the JW Marriott test system are offline) only report when their
> events reach Visionline, for example when the lock is read with a programming unit. Expect *never
> reported* for many doors until that happens. Online locks report as events occur.
> Whether Visionline forwards events that phones collect at the lock depends on the installation. This
> is not in the Web API document, so ask ASSA ABLOY before relying on it.

## How alarms are handled

- **One alert per door.**
  - A repeated alarm adds to the same alert (*2 reports*), and nobody is told again (duplicate
    suppression).
  - A Low alert that becomes Critical is **escalated**: the team is told again, and its maintenance
    request goes up to *High*.
- **Who is told.** Staff whose job role is listed in Settings → Battery & maintenance (default:
  *Maintenance*) are notified in the staff app.
- **On the portal**, the menu badge and the Overview page show the counts.
- **Automatic requests.** A maintenance request opens automatically for **critical** alarms (default), for
  all alarms, or never. Managers can also open one from the door.
- **Closing an alert.** An alert closes in one of three ways:
  - the lock reports a battery exchange;
  - the battery request is resolved with *battery replaced* (the door shows Good until the lock reports
    again);
  - a manager uses **Mark resolved** with a reason.
- **History.** Every reading and alert is kept per door and exported with **Export history** (CSV).

## Maintenance requests

| Source | How |
|---|---|
| Portal | **Maintenance → New request**: what, details, type, priority, a Visionline door or a place, an item, and an assignee (managers). |
| Staff app | **Tasks → Report a problem**: what is wrong and where. "Room 203" is linked to Visionline door 203 automatically. Can be switched off. |
| Battery alarm | Automatic, or from **Battery status** → door → *Open maintenance request*. |

**Flow:** Open → Acknowledged → In progress ⇄ On hold → Resolved → Closed. Cancelled and Reopen are also
available.

- Resolving needs a note on what was done.
- Closing, cancelling and reopening are for maintenance managers.
- Due times come from the priority (urgent 4 h, high 24 h, normal 72 h, low 7 days, all adjustable).
  Overdue requests are marked.
- **Comments and files.** Photos (PNG, JPEG, WebP) and PDFs, up to 3 MB each and 10 per request. Files are
  checked by their content and are only ever downloaded, never displayed as a page.
- **History.** Every change, with who and when, is shown on the request and recorded in the audit trail.
  **Export** writes the requests, and **Export history** writes every change, as CSV. Text that could act
  as a spreadsheet formula is neutralised.
- **Staff app.** The person assigned sees the request under **Tasks**, with a notification. They can
  acknowledge it, start, put it on hold and mark it done, and comment. The reporter can follow their own
  reports.

## Roles

| Role | Battery | Maintenance |
|---|---|---|
| Hotel Administrator | everything | everything |
| Maintenance Manager | see, acknowledge, open requests, resolve | create, assign, prioritise, set due dates, close, cancel, reopen, comment, attach |
| Technician (portal) | see | see, create (not urgent), comment, attach, move up to Resolved |
| Security Manager, Auditor, Read Only | see | see |
| Staff (app) | — | their own tasks; report a problem |

## Settings (Settings → Battery & maintenance)

These settings are part of the versioned hotel policy, so each save can be rolled back.

| Setting | Default |
|---|---|
| Days until a reading is stale | 30 |
| Automatic maintenance request for | Critical alarms |
| Voltage thresholds (6–9 V packs, 3–4.8 V cells) | empty: readings only |
| Due time per priority (hours) | urgent 4, high 24, normal 72, low 168 |
| Job roles told about new requests and alarms | Maintenance |
| Staff can report a problem from the app | yes |

## Trying it with the simulator

The lock simulator page has a **Lock batteries** panel. Click *Low*, *Critical* or *Exchanged* next to a
door, and the lock sends that event to the simulated Visionline. `.\scripts\windows\test.ps1 -Fast` includes
46 Phase 2 checks.
