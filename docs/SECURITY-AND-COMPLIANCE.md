# Security and compliance pack (for hotel groups and institutions, e.g. Marriott vendor review) — Access Monitoring Tool 2.18

**What this is.** The answers a hotel group's IT security team asks of a vendor, prepared in advance. **Approval itself
can only come from the group** (for Marriott: its third-party / vendor risk assessment, normally a questionnaire,
evidence review and an independent penetration test, arranged through the property's IT and Marriott's regional
technology contacts). Nothing in the software can make it "approved"; this pack makes the review shorter.

## 1. What the product is and how it connects

| Component | Runs on | Talks to | Direction |
|---|---|---|---|
| Portal + platform (Node.js, PostgreSQL 16) | The hotel's Visionline server (on-premises package / `.msi`) or a hosted server | Browsers on the hotel network | Inbound HTTPS (TLS 1.2+), hotel LAN only by default |
| Connector (Windows service) | The Visionline server | Visionline Web API on the same server; the platform | Outbound only (HTTPS) |
| Staff app (optional, mobile keys) | Staff phones | Platform; ASSA ABLOY Credential Services (via the ASSA ABLOY SDK) | Outbound |
| ASSA ABLOY Visionline | Unchanged | — | The product never changes Visionline's own configuration or database |

- Visionline is used **only through its documented Web API**, with a dedicated Visionline account; read-only mode is
  available (`readOnly`), and the hotel can run the connector read-only.
- **No change to the PMS or GRMS integrations.** The connector is a polite Visionline client: at most 2 requests at a
  time (configurable `maxConcurrent`), key work first, background reads paused automatically when Visionline answers
  slowly or busy, full reads optionally only at night (22:00–06:00). The effect on the GRMS should be measured on site
  with the GRMS vendor during the pilot (response times of the GRMS calls with the connector on and off).
- No inbound connection from the internet is required (Credential Services callbacks can be switched off; the
  platform polls instead).

## 2. Data inventory

| Data | Personal? | Where | Retention (default, settable) |
|---|---|---|---|
| Portal accounts: name, e-mail, role, salted scrypt password hash, TOTP secret | Yes (staff) | Platform DB | Until removed |
| Staff (mobile keys): name, e-mail, job role, Visionline user id | Yes (staff) | Platform DB | Until removed |
| Visionline people and keycards (read-only copy): name, user group, card number, validity, doors | Yes (staff) | Platform DB | Refreshed by sync; removed when gone from Visionline |
| Lock events: time, door, card number | Yes (indirect) | Platform DB | 730 days |
| Guest in-house list (breakfast / live occupancy): room, guest name, stay dates, guest count | Yes (guests) | Platform DB | 400 days after departure |
| Staff ID profiles: name, ID number, department, job title, photo (JPEG ≤ 400 KB) | Yes (staff, photo) | Platform DB | Until the profile is removed (photo deleted with it) |
| Attendance records | Yes (staff) | Platform DB | Until removed by HR |
| Portal usage counts (pages per person per day) | Yes (staff) | Platform DB | 730 days |
| Audit trail (who did what, when) | Yes (staff) | Platform DB, hash-chained, append-only | Kept (legal evidence) |
| Visionline / Credential Services / SMTP / SMS passwords | Secret | Encrypted (AES-256-GCM) on the platform; Visionline passwords sealed in the browser for the connector (RSA-OAEP + AES-GCM), readable only by the connector | Until changed |

**Not collected:** payment cards (no PCI DSS scope), guest e-mails or phone numbers, passport data, PINs, card serial
numbers (UIDs), location tracking. The supplier usage summary contains counts only and is sent only if the hotel
e-mails it. The software never "phones home".

## 3. Controls

| Area | Control |
|---|---|
| Authentication | Local accounts, scrypt; 5 failures lock an account 15 min; 30 failures per computer; same response time for unknown accounts; optional TOTP two-step sign-in; **administrators can be required to use it**; sessions 8 h, JWT HS256 pinned |
| Authorisation | 14 roles × granular permissions enforced on the server for every request; per-hotel isolation tested on every route (authorisation sweep in each release); modules can be hidden per person (permissions removed server-side) |
| Sensitive actions | Password (and code) re-entered; two people for emergencies and for broad-access keys |
| Transport | TLS 1.2+ on the gateway; HSTS; the connector verifies Visionline's certificate (CA file or pin); TLS verification is never disabled |
| Browser | CSP (self only, no inline scripts, no framing), X-Frame-Options DENY, nosniff, no-referrer, permissions policy |
| Secrets | Never in files, logs or the audit trail; log redaction of authorization headers; secrets shown once |
| Logging | Hash-chained audit trail (tamper-evident; verify from the portal), exportable; printed PDF reports carry a SHA-256 fingerprint, verifiable |
| Availability | Queries limited to a time budget (no single user can exhaust the server); daily database copies; disk/database/connector monitoring with e-mail/SMS alerts |
| Data protection | Retention settings; photo deletion with the profile; data minimisation (see "Not collected") |
| Software supply | Exact dependency versions, at least two weeks old; release checksums (SHA256SUMS); `.msi` to be code-signed with the vendor's certificate |
| Vulnerability management | Internal review each release (SECURITY-REVIEW-2.13.md); independent penetration test recommended before group roll-out |

## 3b. New in 2.14

- **Keycard request page (QR code)** is the only page without sign-in: it accepts a request and nothing else (no data
  is shown except the hotel name and department names). The link carries a random secret (only its SHA-256 is
  stored; a new link stops the old one), requests are limited to 15 per hour per device, and every request must be
  issued by front office or security in the portal.
- **Two people** for unpaid-guest lock-outs and emergency door opening; door commands only during a confirmed
  emergency (never a drill) and only when the hotel switched them on.
- Every keycard encoded, cancelled or overwritten, every lock-out and every door command is in the audit trail.

## 3c. New in 2.15 / 2.16

- **Connector on another computer**: the connector API stays closed on the outside entrance; on the network entrance
  it is open only to the listed connector computer address (`connectorFrom`, a single address or a small range,
  never "private"). The connector checks the server's certificate exactly (`gateway.cer`, fingerprint match) and still
  signs in with its own token. Certificate verification is never switched off.
- **Invitations**: a one-time link (256-bit secret, only its SHA-256 stored, 72 hours, replaced by a new link,
  cancelled when the person is removed); the person chooses their own password (12+ characters). A password link for
  an existing account needs the administrator's password first and keeps two-step sign-in. Every invitation, link,
  acceptance and removal is in the audit trail; the secret never is.
- **Keycards per room** report: same permission and PDF fingerprint as the Event log; no spreadsheet export.

## 3d. New in 2.17

- **Installer questions**: the answers given in the setup window are saved to
  `%ProgramData%\AccessMonitoringToolSetup\answers.json`, readable only by SYSTEM, Administrators and the person installing; a connector token
  typed there is encrypted with Windows DPAPI (machine scope) and the file is deleted when the installation ends (it is
  ignored after 6 hours). For a connector on another computer, the portal certificate's SHA-256 fingerprint is shown in
  the window and checked again before anything is installed. Installation logs never contain the token.
- **Visionline reports import**: only administrators (`settings.manage`) can upload; files are parsed as text (no
  macros or workbooks are opened), limited to 12 MB, kept in the database and listed in the audit trail. A card log keeps
  card number, operator name and time only.
- **Notice board**: posts marked "also on the sign-in page" are visible before signing in (title, text, picture
  only; no author); everything else needs a signed-in user.
- **Mobile keys** are recognised from Visionline's data (no physical serial); still no PIN, e-mail, phone or card serial
  is kept by the directory sync.

## 3e. New in 2.18

- **Lock troubleshooting reports**: uploading needs `battery.manage`, reading `battery.read`, per site. The file is
  parsed as text (15 MB limit). From each event only the lock time, the event code and name, Visionline's "(*)" mark
  and the card type are stored; names, user IDs, card numbers, card serial numbers (S/N) and "issued by" are discarded
  while reading (the sequence number is used only to drop rows read twice). Upload,
  analysis and deletion are in the audit trail.

## 4. Hosting the database (on-premises)

The database lives on the Visionline server's disk. The group will expect **disk encryption** (BitLocker) on that
server and on the backup folder, Windows patching, and the portal reachable only from the hotel LAN or VPN. Database
copies (`.smkbak`) are compressed, not encrypted: keep the backup folder on an encrypted volume with restricted access.

## 5. Gaps a group review is likely to raise (honest list)

1. **Independent penetration test** — not yet done. Budget it (typical: 3–5 days of testing).
2. **Single sign-on** (Microsoft Entra ID / SAML / OIDC) — not yet built; groups often require it for staff portals.
   Local accounts with enforced two-step sign-in are the interim answer.
3. **SOC 2 / ISO 27001** — the vendor company is not certified. For on-premises software this is often accepted with
   the questionnaire and the pen-test report; for hosting it usually is not.
4. **Backups encrypted at rest** — relies on BitLocker today.
5. **ASSA ABLOY** — mobile keys and encoder operations depend on ASSA ABLOY's APIs and the hotel's licences with them;
   the group may ask for ASSA ABLOY's confirmation of the integration (the product uses only documented interfaces).
6. **Data protection agreement** — the hotel is the controller; on-premises installs process no data outside the hotel.
   A hosted deployment needs a DPA and a data-location statement (e.g. Kenya DPA 2019, GDPR for EU guests).

## 6. Evidence to attach to the questionnaire

- This document and SECURITY-REVIEW-2.13.md
- Authorisation sweep output and the automated acceptance test results of the release (≈ 400 checks)
- Architecture diagram (ON-PREMISES.md "What runs where")
- Release checksums (SHA256SUMS) and, once purchased, the code-signing certificate details
- USER-MANUAL.md (roles, emergency procedure, two-person rules)
