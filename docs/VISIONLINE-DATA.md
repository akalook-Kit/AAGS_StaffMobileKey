# Visionline data in the portal (2.10)

The portal follows Visionline: doors, user groups, people and keycards are read from the hotel's Visionline by the
connector, by themselves. Nobody types user group names or presses "discover" any more. Everything is read with GET
requests only; nothing in Visionline is changed.

| What | When it is read | Where to see it |
|---|---|---|
| Doors, door groups, time schedules, Mobile Access account | As soon as the connector has its Visionline account, then every 6 hours (Settings → Visionline: `discoveryEveryHours`, 0 = only by hand) | Settings → Visionline, access templates, key issuing |
| User groups and their doors | From the people in Visionline (every user carries a group), then each group is read for its doors. A group seen for the first time is read at once | **Visionline cards & people → User groups**; Settings → Visionline → Staff user groups |
| People (name, user group) | Every 6 hours on new installations (Settings → Reports & sync) | **Visionline cards & people → People** |
| Keycards (validity, doors, door groups) | With the people, and **within seconds** when a card is made, changed or cancelled at the Visionline desk (live feed, connector 0.9.0) | **Visionline cards & people → Keycards** |
| Lock alarms | With the people (if Visionline has the alarms option) | Insights, Event log |

**Refresh now** (Visionline cards & people) reads everything again straight away (administrators).

## User groups

Visionline's Web API has no call that lists every user group (it documents `GET /userGroups/{name}` only), so the
platform takes the names from the people it reads, then reads each group for its doors. Groups found in Visionline
join the **staff user groups** automatically. On a new installation the placeholder names it starts with
(Housekeeping, Maintenance, …) are replaced by the hotel's own groups as soon as they are known, and the default
staff group moves to a real one. Once someone saves Settings → Visionline, new groups are still added, but nothing
is removed without them.

## Keycards made at the desk

The connector watches Visionline (callback). When a keycard is encoded, changed or cancelled, Visionline reports it;
the platform records the card at once and asks the connector to re-read that one person (doors, validity, group).
In the test setup: `POST http://localhost:14444/sim/desk/cards {"userId":"vl-x","givenName":"A","surname":"B","userGroup":"Engineering"}`
encodes a card at the simulated desk.

## Privacy and limits

- Kept: Visionline user id, names, user group; card number, validity, state, doors, door groups, time schedule.
  Never read or kept: PIN codes, e-mail addresses, phone numbers, card serial numbers, user details.
- A connector installed with `-NoWatch` (a Visionline that is not the hotel's own) reads no people and no keycards.
- Up to 5,000 people per sync on new installations (Settings → Reports & sync).
- Who sees it: roles with reports (Hotel Administrator, Security Manager, Hotel Management, Auditor). Refresh now:
  roles that may read Visionline resources (Hotel Administrator).

## Upgrading from 2.9

Installations whose Visionline settings were made by the installer or the setup page (never saved by a person)
get the automatic sync switched on when 2.10 starts: every Visionline user, every 6 hours. Upgrade the connector at
the same time (the on-premises `Install.cmd` does both) to get keycards recorded live.
