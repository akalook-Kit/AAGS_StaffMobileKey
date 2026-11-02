# Access history, keycard matching and card lookup (2.12)

## Access history (menu: Access history)

Search a **person** or a **door** (or press **Ctrl K** anywhere and type a name).

- **A person**: entrances and refused entries by day, the doors they used (click a door to see who else went
  through), a timeline, and their keycards and mobile keys with validity, deadbolt override and who issued them.
- **A door**: entrances and refused entries by day, everybody who went through (click a name for their history),
  and a timeline.
- Period: 24 hours, 7, 30 or 90 days. Without a choice, the page shows the most active people and busiest doors
  of the week.

It is built from the lock events Visionline reports to the connector (the watch): entrances (the event codes in
Settings → Event log, default 64) and refused entries, plus a mobile key's first use. A lock that is offline
reports when it reconnects. Nothing is read from the locks' own audit trail; history starts when the watch started.
Who can see it: roles with the Event log (Hotel Administrator, Security Manager, Hotel Management, Auditor).

## Lock events matched to keycards (Event log)

Every lock event with a card number now shows **the keycard behind it**: holder, user group, keycard or mobile key,
**who issued it** (the supervisor for a mobile key from this platform; "Visionline desk" for a card made in
Visionline), and badges:

- **No matching keycard** – the card number matches no keycard read from Visionline and no mobile key issued here
  (a card from another system, a very new card not read yet, or a card to look into).
- **Not valid then** – the keycard was not valid at the moment of the event.
- **Deadbolt override** – the keycard may override the deadbolt.

Filter **Keycard: Matches a known keycard / No matching keycard** to list them. The Overview's **Worth a look**
counts them for the last 7 days.

## Card lookup (Visionline cards & people → Card lookup)

Type a card (registration) number: holder (with a link to their access history), user group, validity, doors and
door groups, deadbolt override, time schedule, who issued it, and its last uses at doors (90 days).

### Read a card at the encoder (pilot)

Settings → Reports & sync → **Encoders**: tick *Allow reading cards at these encoders* and enter the encoder names
as in Visionline (for example `fd1`). Card lookup then shows **Read card on fd1**: put a keycard on the encoder and
press it; the card is read (nothing is written to it) and looked up.

The connector (0.10.0) sends `POST /cards?action=read&encoder=fd1` to Visionline (encoder operations take the
encoder as a query parameter, as in ASSA ABLOY's own Postman reference `action=encode&encoder=fd1`). The read
action's exact name must be confirmed on the hotel's Visionline: run the probe with a card on the encoder,

    connector\visionline-probe.ps1 -AccessId <id> -Encoder fd1

and use the action it reports (`read` or `readCard`) in Settings. Until it is confirmed, keep the switch off.
The probe also reports which time formats this Visionline accepts in queries (the 2.11.1 "Time must be in UTC" fix).

## Choosing whose cards are read (Settings → Reports & sync)

- **Whose cards**: the staff user groups, **chosen user groups** (click the groups; each shows how many people it
  had at the last read), or everyone in Visionline.
- **At most this many people** per read, and how often to read.
- **Valid keycards**: validity, doors, door groups, time schedule and **privileges such as deadbolt override**
  (when Visionline reports them on the card; otherwise shown as "not reported").
- Keycards can be filtered by deadbolt override in Visionline cards & people → Keycards, and in reports.
