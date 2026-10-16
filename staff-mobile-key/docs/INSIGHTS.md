# Insights (management reports) — release 2.5

**Insights** is a report canvas in the portal, laid out like a Power BI report: slicers across the top
(period 7/30/90/365 days, user group, floor), KPI tiles with the change against the previous period and a
trend line, and report pages. Every chart has a **Table** view and a CSV export, and every page prints to PDF.

## Who can see it

| Role | Insights | Start a Visionline read | Settings |
|---|---|---|---|
| Hotel Admin | yes | yes | yes |
| **Hotel Management (reports)** — new | yes | no | no |
| Security Manager, Auditor | yes | no | no |
| Key Issuer, Maintenance, Technician | no | no | no |

## Report pages

| Page | What it shows |
|---|---|
| **Summary** | Valid keycards, active mobile keys, lock alarms, refused entries, open maintenance requests, doors with a battery problem; daily trend; doors needing attention |
| **Keycards & people** | Valid keycards per Visionline user group (mobile keys vs. other cards), people without a valid card, cards expiring within 7 days, staff per department with phones set up and keys issued; click a group for its people and their cards |
| **Locks & batteries** | Alarms and refused entries per lock, alarm types; battery life from Visionline events: median days from battery change to "low", locks **draining fast**, locks **doing well**, locks **due soon** (predicted to reach "low" within 30 days) |
| **Maintenance** | Requests by category and status, overdue, workload and average time to resolve per person |
| **Valid keycards** | Searchable list of every valid card: holder, group, valid from/until, doors, time schedule; filter "expiring within N days" |

Exports (CSV, UTF-8 with BOM so Excel keeps accents, formula-safe): `valid-cards`, `user-groups`,
`lock-activity`, `battery-life`, `departments`, `maintenance-workload`. Each export is recorded in the audit
trail.

## Where the numbers come from

| Data | Source |
|---|---|
| Mobile keys, staff, departments, phones | The platform itself |
| People, user groups, keycards (all types) | **Visionline directory read** (below) |
| Lock alarms | Visionline `/alarms` (needs the Visionline option *Web service for checking and confirming alarms*; without it the page says so) |
| Refused entries, battery events | Visionline lock events received by the connector (watch) |
| Maintenance | Phase 2 maintenance requests |

### Visionline directory read

Switched **off** by default. **Settings → Reports & sync**: switch on, choose *staff user groups only* or *all
user groups*, cards and alarms, how often (default every 24 h), maximum users (default 3,000). **Read
Visionline now** starts it at once; the history shows each run.

- **Read-only.** The connector only calls `GET /users`, `/users/{id}`, `/cards`, `/cards/{id}`, `/alarms`,
  `/alarmTypes`. It works with a connector installed with `-ReadOnly`. It needs connector 0.6.0.
- Runs in the background on the connector, two requests at a time with a short pause, so Visionline stays
  responsive; results are sent in chunks of 400.
- **What is kept:** user id, first and last name, user group; for each currently valid card: reg. no., holder,
  format, valid from/until, door count, door groups, time schedule, state flags. **Never kept:** PIN codes,
  e-mail addresses, phone numbers, user detail fields, card serial numbers. The database tables have no
  columns for them, and an automated check confirms none appear in any report or export.
- People and cards no longer in Visionline are marked inactive at the next full read.

## Trying it with demo data (test environment only)

```powershell
docker compose exec backend npx tsx src/tools/demo-history.ts --hotel k-hotel-bana --yes     # add
docker compose exec backend npx tsx src/tools/demo-history.ts --hotel k-hotel-bana --remove  # remove
```

It adds tagged history (battery cycles, alarms, refused entries, maintenance requests, past keys) so the charts
have something to show. It refuses to run in production.
