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

## Times sent to Visionline (2.11.1)

Visionline versions differ in the time format they accept in queries. Connector 0.9.1 sends alarm times in UTC with the
"Z" and, if Visionline answers "Time must be in UTC." (or another time-format error), tries the other documented forms
once and remembers the one that works. A problem reading lock alarms no longer fails the whole read: people and
keycards are still recorded and the alarm problem is shown as a note under **Recent reads**. Error messages now say
which request failed (for example `GET /alarms?updatedSince=…: …`).

## More in 2.12

Choosing exactly which user groups are read, deadbolt-override privileges on keycards, access history, lock
events matched to keycards, card lookup and reading a card at the encoder: see [ACCESS-HISTORY.md](ACCESS-HISTORY.md).

## Sharing Visionline with the PMS and the GRMS (2.13)

Visionline serves several systems at once: the PMS encodes guest cards, the GRMS checks rooms, the portal reads people
and events. The connector makes sure the portal never crowds the others out:

- **At most 2 requests at a time** to Visionline, with a short pause between them. Key work (issue, revoke, card
  lookups, encoder reads) goes first; background reads (people, keycards, doors) wait.
- **Backs off by itself**: when Visionline answers "busy" (503/429) or a request times out, background reads pause
  for 30 seconds; when answers take more than 2 seconds, the connector slows to one request at a time.
- **Night-only full reads**: *Settings → Reports & sync → Only at night (22:00–06:00)* runs the full read of people
  and keycards at night (the first read after switching it on still runs straight away).
- Encoder reads are limited to one every 3 seconds and 20 a minute.
- Settings on the connector (only if the GRMS vendor asks): in `connector.config.json`,
  `"visionline": { "maxConcurrent": 1, "minGapMs": 100 }` (or the variables `VL_MAX_CONCURRENT`, `VL_MIN_GAP_MS`),
  then restart the *Staff Mobile Key Connector* service. *Connector health* shows the queue.

The long-poll that waits for Visionline events is not counted: it holds a connection open but costs Visionline nothing
while idle.

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
