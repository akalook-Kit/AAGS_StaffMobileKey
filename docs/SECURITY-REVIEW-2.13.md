# Security review of release 2.12 (fixed in 2.13)

Internal "blue team" review of the built 2.12 platform (on-premises package and portal) before 2.13. Method: every
API route was called as nobody, as a member of another hotel and as each of the 13 roles (authorisation sweep, 169
hotel routes); the new 2.12 features (access history, highlights, report builder, encoder reads, licences) were
attacked with oversized ranges, malformed ids, injection strings and timing measurements; the response headers and
token handling were checked. The sweep was repeated on 2.13 including the new routes (muster, emergency, ID cards,
usage): **no anonymous access, no access across hotels, no server errors**.

This is a review by the developer, not an independent penetration test. Marriott (and most hotel groups) will ask
for an independent test by an accredited firm before production; see SECURITY-AND-COMPLIANCE.md.

## Findings

| # | Severity | Finding | Status in 2.13 |
|---|---|---|---|
| F1 | **High** | Any Event-log reader could exhaust the server's memory and CPU (denial of service) | Fixed |
| F2 | Medium | Account enumeration through sign-in timing; password hashing blocked the server | Fixed |
| F9 | Medium | A stolen portal session could switch two-step sign-in off for its account | Fixed |
| F3 | Low | An operator could write an audit-trail entry into a hotel they do not belong to | Fixed |
| F4 | Low | No anti-framing / content-security headers when the platform is reached directly (cloud hosting) | Fixed |
| F5 | Low | Malformed ids in the address returned server errors (500) | Fixed |
| F6 | Low | Encoder reads could be repeated without limit, loading the shared Visionline | Fixed |
| F7 | Info | Licence exemption patterns not anchored (no exploit found) | Hardened |
| F8 | Info | JWT algorithm not pinned (HS256 key; no exploit found) | Hardened |
| F10 | Info | Event-log text search no longer found lock-event names after the F1 fix (regression caught by the tests) | Fixed |

### F1 (High, the strongest and newest): memory and CPU exhaustion through the event log

Introduced in 2.12 with *Access history* and *Highlights*. The event log merged lock events, card events, alarms,
key events and connector failures **in the server's memory** and filtered them there. Every request for a long period
loaded every event of that period. With 600,000 lock events (about a year at a busy 300-room hotel):

- one request took **33 seconds and 880 MB** of memory; four requests in parallel from one browser tab exhausted the
  Node.js heap and stopped the platform for every user (and the connector's channel with it);
- any role with *Event log* (Security manager, Hotel management, Auditor) could trigger it, by accident too (choosing
  "1 year" and a busy door).

Fix: the whole query (merge, classification, filters, counts, paging) runs in PostgreSQL with indexes, inside a
read-only transaction with a statement time limit; a request asks for at most 5,000 rows; a query that would run too
long answers *"Narrow the period"* (503 QUERY_TOO_LONG) instead of holding the server. Measured on the same data:
**1.2 s and 197 MB** for the event log, 3.5 s for a person's access history, no growth with parallel requests.

### F2 (Medium): who has an account, by timing

Signing in with an unknown e-mail answered in 27 ms, with a known e-mail and a wrong password in 60 ms: an attacker
could list valid accounts. The password check (scrypt) also ran on the main thread, so a burst of sign-ins slowed
every user. Fix: unknown accounts are checked against a dummy hash (same cost), scrypt runs in the thread pool, and
failed sign-ins are also limited per computer (30 per 15 minutes) besides per account (5 per 15 minutes). Measured
after: 45–66 ms in both cases.

### F9 (Medium): two-step sign-in could be reset with a session alone

`POST /auth/mfa/setup` replaced the secret and switched two-step sign-in off, even when it was on. Someone holding a
stolen session (for example from an unlocked PC) could switch it off and later sign in with the password only. Fix:
setup is refused while two-step sign-in is on; a lost phone is handled by another administrator (*Operators → Reset
two-step*), who must re-enter their password, and it is audited.

### F3–F8 (Low / Info)

- **F3** `DELETE /me/visionline-credentials` wrote its audit entry under any hotel id given in the address; now
  membership is checked first.
- **F4** The on-premises gateway set browser protections, the platform itself did not. Every answer now carries
  `X-Frame-Options: DENY`, a content security policy (no framing, no external scripts or fonts, no plugins),
  `nosniff`, `Referrer-Policy: no-referrer`, a permissions policy, and HSTS on HTTPS.
- **F5** Database type errors (malformed UUID, date, number) now answer 400.
- **F6** Encoder reads: at most one every 3 seconds and 20 a minute per hotel.
- **F7** The routes that stay open when a licence has ended are matched exactly.
- **F8** Tokens are verified with HS256 only.

## New in 2.13 (security-relevant)

- **Administrator protection**: a hotel can require two-step sign-in for administrators; until it is on, Settings,
  Operators, Branding and connector management stay closed to them (server-side).
- **Re-authentication** for sensitive actions (starting/confirming an emergency, resetting someone's two-step
  sign-in): the password (and code) again, valid 5 minutes, kept in memory only.
- **Two-person rule** for emergencies; every step audited; emergency keys only while an emergency confirmed by two
  people is active, never during a drill.
- **ID photos** are accepted only as JPEG (magic bytes checked, ≤ 400 KB); SVG and other active formats are refused.
- **Usage summary** for the supplier: counts only, signed with an installation key kept encrypted in the secret store;
  never sent automatically.
- **Visionline sharing**: one limiter for the whole connector (at most 2 requests at a time, background reads pause
  when Visionline is slow or busy), so the portal cannot crowd out the PMS or the GRMS.

## Residual risks and recommendations

1. Commission an **independent penetration test** (web application + on-premises host) before group-wide roll-out.
2. Turn on **Require two-step sign-in for administrators** at every hotel.
3. Keep the Visionline server patched and the portal reachable only from the hotel network (or the documented secret
   pathway); never expose Visionline itself.
4. Code-sign the `.msi` (LICENSING.md).
5. The content security policy blocks `eval`; one library probes it at start-up, which shows one harmless console
   message. No inline scripts are used.
