# Security review 2.20 (31 Oct 2026)

A defensive review of the Access Monitoring Tool's own code, done by reading it and testing it in the test stack
(not an attack on any live server). Scope: sign-in and sessions, permissions between sites and roles, everything
reachable without signing in, uploads, exports, the gateway (outside entrance and the new Cloudflare Tunnel entrance),
secrets, and the libraries the platform uses.

## Fixed in 2.20

| # | Finding | Risk | Fix |
|---|---|---|---|
| 1 | A session stayed valid for up to 8 hours after the person's password was changed, reset with a password link, or their two-step sign-in was reset — a stolen session survived the reset. | Medium | Each account has a session version, raised on password change, password link and two-step reset; sessions carrying an older version are refused at once. The person who changes their own password keeps working with a new session. |
| 2 | A two-step (authenticator) code could be used again within its 90-second window, e.g. after being seen over someone's shoulder. | Low | Each code works once per account; the comparison is constant-time. |
| 3 | The new tunnel entrance must not let one visitor's wrong attempts block everybody (all tunnel traffic comes from the same local program). | Medium (new feature) | The gateway takes the visitor's real address from Cloudflare's header — only on an entrance bound to 127.0.0.1 that admits the local machine only, so the header cannot be forged from the network; checked when the settings are saved. A tunnel request without that header is refused. |
| 4 | Redirects under the secret path (new for invitation links) could be abused to send someone to another site with `//host` or `/\host`. | Medium (new feature) | Only same-site paths are allowed; anything else goes to `/`. Unit-tested. |
| 5 | The audit export and the keycard register export did not neutralise cells starting with `=`, `+`, `-`, `@` (a door or person name from Visionline could become a spreadsheet formula). | Low | Such cells are prefixed with `'`, as in the other exports. |
| 6 | Own password change accepted 10 characters (12 everywhere else). | Low | 12 characters, at most 200. |
| 7 | fastify 5.12.5: header validation bypass (published advisory). | Low | Upgraded to fastify 5.12.6 (published 13 Oct, older than two weeks). |

## Checked, no change needed

- **Sites kept apart:** every one of the 223 portal routes was called with the other test site's administrator and with
  each role; none returned another site's data (automated sweep, 0 findings).
- **Database queries** are parameterised; the few pieces of SQL built in code are fixed text or numbers.
- **Passwords** are hashed with scrypt; sign-in is limited per account (5 failures → 15 minutes) and per address
  (30 per 15 minutes); the setup code is compared as a hash, with a global limit of 10 tries per 15 minutes.
- **Links without sign-in** (invitations, password links, keycard request page) use long random tokens stored only as
  hashes, used once or replaceable, and the request page is limited to 15 requests per device per hour.
- **Uploads** (Visionline reports, lock reports, gateway lists, pictures) are read as text or checked images, size-
  limited, and never stored as files; names and card numbers in lock reports are discarded.
- **Pages:** no HTML from data is inserted (the only raw HTML is the QR code drawn in the browser from the portal's
  own link); the gateway sends a strict Content-Security-Policy, X-Frame-Options DENY, no-referrer, HSTS on https.
- **The platform** listens on 127.0.0.1 only; the connector API is closed on outside and tunnel entrances.
- **Secrets** (Visionline and Credential Services passwords, SMTP, tokens) are not in files, logs or the audit trail;
  the Cloudflare tunnel token goes to Cloudflare's program only.

## To do in the next release (fixes too new for the two-week rule)

| Library | Advisory | Why it waits | Exposure here |
|---|---|---|---|
| fast-uri 4.2.2 | URI scheme spoofing via percent-encoded scheme | Fixed in 4.2.3 (19 Oct 22:51 UTC) — two weeks old from 2 Nov evening: next release | Used inside the JSON validator for "uri" formats, which the portal's own checks do not use. Low. |
| nodemailer 10.0.11 | address parser can turn display text into a recipient | **Done in 2.24: nodemailer 10.1.7** (18 Oct) | Only addresses typed by administrators (checked as e-mail addresses) are used. Low. |
| @fastify/static (glob, minimatch) | denial of service / cancellation bypass in glob patterns | Fix only by going back a major version | The portal serves fixed files; no user-supplied patterns. Low. |

## Recommendations for the hotel

1. **Turn on "two-step sign-in required for administrators"** (Settings → Policy → Administrator protection).
2. With outside access, put **Cloudflare Access** (e-mail one-time PIN, allowed addresses only) in front of the portal.
3. Give the connector its **own Visionline operator** (not a PMS/interface account), so Visionline's own log is clear.
4. Before a group (e.g. Marriott) vendor review, have an **independent penetration test** of the installed server; this
   review covers the code, not the hotel's network or Windows set-up.
