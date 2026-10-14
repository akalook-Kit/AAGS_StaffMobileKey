# Vendor documentation mapping

Sources: **ASSA ABLOY Global Solutions Web API**, DocNo 61 1100 080, revision 74 (valid from 2022-08-15),
and **AAH Credential Services API V2.5.1** (23 March 2017). Status: **Documented** (taken from the text),
**Inferred** (reasonable reading, safe default chosen), **Vendor confirmation required**.

All vendor names live in one file: `packages/shared/src/visionline/contract.ts` (Visionline) and
`packages/shared/src/credential-services.ts` (Credential Services).

## Confirmed against ASSA ABLOY's official Postman collection (13 Oct)

The hotel supplied ASSA ABLOY's own Visionline Postman collection and environment (exported 2020-04-22).
It is the vendor's own reference, and it confirms the connector's behaviour independently of the document:

- **Request signing is byte-identical.** The environment holds a real signed request (its access key,
  Content-MD5, `x-aah-date` and the signature their tooling produced). Our `sign()` reproduces that exact
  signature — the vendor's pre-request script and our code build the same string-to-sign and HMAC-SHA1
  over the access key as UTF-8. Kept as a regression test (`signing.test.ts`, "matches ASSA ABLOY's
  Postman reference signature"). This is the part most likely to be wrong against a real server, and it
  is now proven correct from the vendor's own data.
- **Web-client session shape confirmed.** "Create a session for extended resources" sends
  `username` + `password` + `accessID` + `uuid`, exactly as the connector does for the Web API client.
- **Mobile-key fields confirmed.** Guest mobile-key requests use `doorOperations`, `expireTime`, `format`,
  `endPointID`, `accountName`, and optional `label` / `description` / `url` with `%ROOMNUM%` / `%CARDNUM%`
  placeholders — matching our connector and the `KHB %ROOMNUM%` key label. **No `startTime`** appears on
  any card-creation example, staff or mobile, which supports holding a future key until its start time.
- **Battery monitoring is the documented path.** The vendor's own "Callback events" example filters on
  `eventCode` including **304** (battery low), confirming that reading battery alarms through a `/callback`
  event filter (Phase 2) is exactly how ASSA ABLOY expects it to be done.

The collection does **not** contain the Mobile Access mobile SDK; that still comes from ASSA ABLOY under an
integrator agreement.

## Visionline Web API (connector)

| Topic | Implementation | Source | Status |
|---|---|---|---|
| Transport | HTTPS, TLS 1.2+, certificate always verified (CA file and/or SHA-256 pin) | §1, §3.1 | Documented |
| Base URL | `https://127.0.0.1/api/v1`, per-hotel config value; version `v1` | §4.2, spec §12.1 | Documented |
| Session | `POST /sessions` `{username, password[, accessID, uuid]}` → `{id, accessKey[, webClientID]}`; unsigned | §5.24, §7.1.1–7.1.2 | Documented |
| Operator card | Web client set to *Ignore operator card* | §5.24, §7.1.2 | Confirmed by the hotel (13 Oct) |
| Signing | HMAC-SHA1 over verb, Content-MD5, Content-Type, Date, `x-aah-date`, path + sorted query; `Authorization: AWS id:sig` | §4.5, §6.1 | **Verified against §7.1.3/§7.1.4 test vectors** |
| Clock skew | On 40101, adopt server `Date` and resend | §4.5.7, §6.1 | Documented |
| Session expiry | On 40103, new session and resend (request was not carried out) | §3.2, §4.6 | Documented |
| Terminate session | `DELETE /sessions/{id}` on shutdown | §5.25, §7.1.5 | Documented |
| Unknown properties | Ignored | §4.7 | Documented |
| Dates | Hotel local time `YYYYMMDDTHHmm`; converted with the hotel IANA time zone; expiry rounded down to the minute | §4.3.2, §7.5.6 | Documented |
| Doors / floors | `GET /doors?details=true`; door groups derived from `doorGroup`; floors resolved to explicit doors | §5.12–5.13, §7.10 | Documented |
| User groups | `GET /userGroups/{id}` for each group in Settings → Visionline (no collection is documented); `PUT /userGroups/{id}` `{uniformAccess}` creates one ("Create in Visionline"); a group's `doorOperations` can be added to a key or template | §5.29 | Documented |
| Uniform-access groups | For holders in a uniform-access group, `doorOperations` is omitted and Visionline applies the group's doors | §5.29.3 | Documented |
| Card holder | `GET /users/{id}`, `PUT /users/{id}` `{surname, givenName, userGroup}` if missing | §5.31, §7.2.1 | Documented |
| Door entrances (2.6, event log) | The connector's `/callback` registration adds the hotel's entrance event codes (Settings → Event log; default 64 "staff card accepted") to the refused-door and battery codes; a change replaces the callback (`DELETE /callback/{id}`, new `POST /callback`) | §7.14, §7.14.1, §7.15 | Documented; other accepted-card codes per hotel lock documentation |
| Directory read (2.5, reports) | Read-only: `GET /users`, `GET /users/{id}` (only id, names, userGroup are kept; PIN, e-mail, phone and userDetails are dropped in the connector), `GET /cards?cardHolder={id}&validTime=now`, `GET /cards/{id}` (flags cancelled/discarded/overridden/expired/notIssued, door groups, time schedule) | §5.30–5.31, §5.9.3, §5.10 | Documented |
| Lock alarms (2.5, reports) | `GET /alarmTypes`, `GET /alarms?updatedSince=` (UTC), `GET /alarms/{id}`; needs the Visionline option *Web service for checking and confirming alarms* — without it the report says so | §5.1, §5.3–5.4 | Documented; option to be confirmed per hotel |
| Mobile accounts | `GET /mobileaccess` → `name`, `description`, `systemID` | §5.16–5.17 | Documented |
| Staff mobile key | `POST /cards?action=mobileAccess` `{cardHolder, doorOperations:[{operation:"normal", doors}], expireTime, format:"TLCode", endPointID[, accountName, timeSchedule, label]}` → `{credentialID}` | §7.5.2, §7.5.6 | Documented |
| Delivery | Visionline sends the key to Credential Services; `returnCredential` is **not** used | §7.5.1, §7.5.7, spec §12.5 | Documented (by design) |
| Start time | Every key has a start and an end (hotel decision). Default: a future key is held by the platform and created at its start time, because staff card startTime "should not be in the future" (§7.6.2). Setting *Send future start time* sends `startTime` instead (§7.5.2) | §7.5.2, §7.6.2 | Hotel decided; vendor confirmation required for "send" |
| Change doors | `POST /cards?action=mobileAccess&override=true` replaces the holder's current staff card (the remedy 40902 names). With Visionline Options → Mobile Access → *Revoke mobile key when overridden*, the old key is removed from the phone; with *when expired*, the platform also checks the old key out | §5.9.4, §4.4.1 (40902), Visionline Options | Inferred from the option name; vendor confirmation required |
| Mobile Access UUID | Not exposed by the Web API. Recorded per hotel in Settings → Visionline (K Hotel: 9) and given to the app for the vendor SDK | Visionline Options → Mobile Access | Vendor confirmation required (SDK parameter) |
| Operator credentials | Property operator and optional per-operator credentials, both used only by the connector for `POST /sessions`; entered in the portal and sealed in the browser for the connector (RSA-OAEP-256 + AES-256-GCM) | §5.24 | Documented (session); sealing is a platform design |
| One staff key per user | One live key per person; *Change doors* issues a new key (new reg. no.) with `override=true` | §7.6.4 note, §4.4.1, §5.9.4 | Confirmed by the hotel (13 Oct) |
| Time schedule | Chosen per access template from the discovered `/timeSchedules`; sent only for keys from that template | §5.10.2, §5.26, §7.6.2 | Hotel decided; honoured on staff mobile keys (answer received 13 Oct) |
| Revocation (check-out) | Default revoke: `POST /doors/{door}` `{checkedOut:true, credentialID}` for every door in the key | §5.13.4, §7.13.5 | Documented; hotel decided |
| Revocation (cancel card) | Wrong-door limit and "Cancel card in Visionline": `GET /cards/{reg. no.}` (holder check), then `POST /cards/{reg. no.}` `{cancelled:true}`. Without a stored reg. no. the holder's only valid card is used (one staff card per user); otherwise it refuses. Other cards are not touched. Visionline then revokes the key from the phone through Credential Services | §5.10, §7.6.4, §7.7.4 | Documented + answer received 13 Oct |
| Reg. no. vs credential ID | They differ (answer received 13 Oct; check-out has separate `cardID` and `credentialID`, error 41502). After `POST /cards?action=mobileAccess` returns the `credentialID`, the connector finds the card's registration number with `GET /cards?cardHolder=…&startTime=…&expireTime=…` and `GET /cards/{id}` (newest, not cancelled). Check-out uses the credentialID; card cancel, card callbacks and lock events use the reg. no. | §5.9.3, §5.10.2, §5.13, §7.13.5, §7.14 | Documented + answer received |
| Cards cancelled in Visionline | Connector registers `POST /callback` `{resources:{cards:{fields:[registrationNumber,status,cancelTime,cardHolder,expireTime]}}}`, long-polls `GET /callback/{id}` (up to 4 min), and on start catches up with `GET /cards?cancelTimeSince=`. Status 0 (cancelled) or 6 (discarded) → key revoked in the app; 2 (overridden) / 4 (expired) end the key | §5.9.3, §7.14.2, §7.15, §7.16 | Documented; hotel decided |
| Wrong doors ("wandering") | Same callback with `events:{eventCode:[320,322,323,325,327,368,369]}`. Events 320 *No access to this room* and 323 *Card can only access Common rooms* for the key's reg. no. are counted; after **more than 5** the card is cancelled. Repeats within one minute arrive as one event with `repeatFlags`; offline locks report only when their events reach Visionline | §7.14.1 | Documented; hotel decided |
| Errors | Numeric codes mapped to actionable messages (40101, 40102, 40103, 40308, 40328, 40406, 40052, 40902, 40904, 50301…) | §4.4.1 | Documented |
| Battery (phase 2) | Battery events in the connector's `/callback` events filter: low 304/306/529/533, critical 53/305/307/530–532/534, exchanged 528/535/536, "below X volts" 1056–1081; long-poll; 12 h record expiry | §5.7–5.8, §7.14.1, §7.16 | Implemented (connector 0.5.0, platform 2.4.0). Offline locks report only when their events reach Visionline. |

## Credential Services (cloud backend)

| Topic | Implementation | Source | Status |
|---|---|---|---|
| Authentication | HTTP Basic, tenant user | §3 | Documented |
| Media type | `application/vnd.assaabloy-com.credential-2.x+json` for Accept and Content-Type | §4.2 | Documented |
| Invitation | `POST /endpoint/invitation` `{endpointId}` → `{invitationCode, endpointId}`; 10 h validity; same code while unused; `10008` if active | §6 | Documented |
| Endpoint id | UUID generated by the platform (allowed: `a-zA-Z0-9-_`, ≤ 50 chars for Visionline) | §6.2.3, Web API 40507 | Documented |
| Endpoint lookup / delete | `GET`, `DELETE /endpoint/{id}`; delete before re-inviting the same id | §5.3–5.4, §6.1 | Documented |
| Credential lookup | `GET /system/{systemId}/credential/{credentialId}` for reconciliation | §7.2 | Documented |
| Callbacks | `POST /callback` for ENDPOINT, CREDENTIAL, READBACK with per-hotel Basic credentials | §8.2 | Documented |
| Endpoint callback | Only the transition to ACTIVE produces a callback | §8.5.1 | Documented |
| Credential states | ISSUING, ISSUED, *_FAILURE, UPDATING, REVOKING, REVOKED mapped to key states | §7.2.4, §8.5.2 | Documented |
| Readback | `sessionTransceived` records first use at each door | §8.5.3 | Documented |
| Base URL and account | K Hotel Bana: `https://hospitality.credential-services.api.assaabloy.com`, System ID 3460, account `hma-cs-92a0dc3e-…` (docs/K-HOTEL-BANA.md). Password only in the platform secret store; `scripts/windows/cs-check.ps1` tests it read-only | not in the document | From the hotel (13 Oct) |
| Error codes | Only `10008` is documented ("details to follow") | §4.3.3 | Vendor confirmation required |
