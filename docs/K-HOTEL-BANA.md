# K Hotel Bana — site values

Values received from the hotel on 12–13 October 2026. **No passwords are kept in this project.** The
Credential Services password goes only into the platform's secret store, as described below.

## Visionline (Options → Mobile Access)

| Setting | Value | Where it is used |
|---|---|---|
| Mobile Access UUID | **9** | Settings → Visionline → Mobile Access UUID. Sent to the staff app for the ASSA ABLOY SDK: it identifies the SEOS channel used to issue keys. |
| Revoke mobile key | **when overridden** | Settings → Visionline. *Change doors* relies on it. |
| Mobile Access account name | `hma-cs-92a0dc3e-6379-4b84-999c-aedb582c1b63` | Settings → Visionline → Mobile access account, sent as `accountName` when a key is created (Web API §7.5.2) |
| Web API client | *Ignore operator card* | Connector session (§5.24) |
| Web API address | `https://localhost/api/v1` on the Visionline PC | Connector `-VisionlineUrl` |

## Credential Services (the SEOS account Visionline uses)

| Setting | Value | Where it is used |
|---|---|---|
| URL | `https://hospitality.credential-services.api.assaabloy.com` | Settings → Credential Services → URL (production) |
| System ID | **3460** | Settings → Credential Services → System ID. Readiness checks it against Visionline's account. |
| User | `k_-_hotel_bana-lhtgdm7qp6jsbsm` | Platform secret `SECRET_CS_TENANT_USER` |
| Password | not recorded | Platform secret `SECRET_CS_TENANT_PASSWORD`, entered by the hotel |

This user is the account configured in Visionline. With it, the platform requests phone invitations
(`POST /endpoint/invitation`) and receives credential callbacks for keys this system issues. Callbacks
registered by the platform are added next to any existing ones; several URLs per type are allowed (§8.2).

### Check the account first (read-only)

```powershell
.\scripts\windows\cs-check.ps1 -User k_-_hotel_bana-lhtgdm7qp6jsbsm -SystemId 3460
```

Type the password when asked; it is not shown or stored. The check only reads: it lists callbacks,
looks up a random endpoint and checks the System ID. It reports whether the URL needs a path after the
host name.

### The test environment on your PC

It keeps using the **simulator** for Credential Services, because simulated phones cannot use the real
SEOS service. The simulator mirrors the real account name and System ID 3460, so Settings and readiness
look the same as in production.

### For the pilot (real phones, licensed SDK)

On the platform server, not on the Visionline PC:
1. Set the secrets in the server's secret store or environment. For a Docker deployment, put them in
   `.env`, which is never committed:
   ```
   SECRET_CS_TENANT_USER=k_-_hotel_bana-lhtgdm7qp6jsbsm
   SECRET_CS_TENANT_PASSWORD=<typed by the hotel>
   PUBLIC_URL=https://<public address of the platform>
   ```
   `PUBLIC_URL` must be reachable from the internet, because Credential Services calls it back.
2. Settings → Credential Services: URL as above, System ID 3460.
3. Connector health: readiness *Credential Services System ID matches Visionline* and *callbacks
   registered* are green.

## Answers from ASSA ABLOY and the hotel (12–13 Oct 2026)

Moved here in 2.33.1 from the Connector health page (they were shown at every hotel).

- **Staff key start time:** the API has startTime, but staff keys are expected to start immediately; a future start is
  treated as not supported. The platform holds a future key and creates it at its start time (default).
- **Credential Services:** URL https://hospitality.credential-services.api.assaabloy.com, user k_-_hotel_bana-…,
  System ID 3460, account hma-cs-92a0dc3e-…, Mobile Access UUID 9. The password is only in the platform secret store.
- **Revocation:** cancelling or checking out a mobile staff key in Visionline revokes it from the phone through
  Credential Services; the platform also revokes it in the app when the connector reports the cancellation.
- **Wrong doors:** more than 5 wrong-door attempts (events 320/323) cancel the card automatically (hotel).
- **Time schedule** is honoured on staff mobile keys; used only when the access template sets one.
- **credentialID is not the card registration number:** the connector looks it up with GET /cards?cardHolder=… after
  creating the key; callbacks, lock events and card cancel use it; check-out uses the credentialID.
- The Web API client is set to **Ignore operator card**.
- **One live key per person;** Change doors uses override=true and gets a new registration number.
