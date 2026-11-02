# Reaching the portal from outside the hotel (2.20)

The hotel's IT does not have to give a public IP address or open anything inbound. With **Cloudflare Tunnel**, a small
Cloudflare program on the portal server (`cloudflared`) makes an **outgoing** connection to Cloudflare, and your own
address (for example `https://portal.afratech.africa`) reaches the portal through it.

```
 Staff phone / laptop ──https──▶ Cloudflare (your domain, TLS certificate)
                                        ▲
                                        │ outgoing connection, opened by the server (port 7844)
                                        │
 Portal server:  cloudflared ──▶ gateway "tunnel" entrance (127.0.0.1:8447) ──▶ portal
```

## What the hotel's IT needs to know

- **Nothing is opened inbound.** No public IP, no port forwarding, no firewall rule from the internet.
- The server needs to reach Cloudflare **outbound on port 7844** (TCP and/or UDP — the tunnel itself) and **TCP 443**
  (Cloudflare's API and updates). Many hotel firewalls already allow this; if 7844 is blocked outbound, IT must
  allow it for this server. IT can restrict it to Cloudflare's published address ranges.
- The tunnel entrance on the server listens on **127.0.0.1 only**: nobody on the hotel network can use it.
- Turning it off is one command (`set-tunnel-access.ps1 -Disable`) plus deleting the tunnel in Cloudflare.

## Layers of protection

1. **Cloudflare Access** (recommended, free for up to 50 users): before the portal even loads, Cloudflare asks for
   the person's e-mail address and sends a one-time PIN; only the addresses or company domain you allow get in.
2. **Secret path** (on by default): the outside address is `https://portal.afratech.africa/k-…`; without the
   secret part it answers "Not found", so scanners on the internet see nothing. Invitation links made in the portal
   include it automatically (Users → Invite someone shows a second link, "From outside the hotel").
3. **The portal's own sign-in**: personal accounts, passwords of 12+ characters, two-step sign-in for administrators,
   and repeated wrong attempts are blocked per visitor (the gateway sees each visitor's real address through the
   tunnel, so one person's mistakes never lock out the others).

**Privacy note:** Cloudflare terminates TLS at its edge, so Cloudflare technically sees the traffic. For a group
security review this should be mentioned; if it is not acceptable, use a relay server you own instead (ask us).

## Setting it up (about 20 minutes)

### 1. The domain on Cloudflare

- A domain whose DNS is on Cloudflare (free plan). Either move an existing domain's nameservers to Cloudflare, or
  register a separate one just for the portal. (Cloudflare Tunnel needs the domain's DNS on Cloudflare.)

### 2. The tunnel in the Cloudflare dashboard

1. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**; name it, e.g. `khb-portal`.
2. Choose **Windows**; Cloudflare shows an install command ending in `service install eyJ…`. Copy **only the long
   token** after `service install` (keep it like a password).
3. **Public Hostname**: subdomain `portal`, domain `afratech.africa`, **Service type HTTP**, **URL `localhost:8447`**.
4. (Recommended) **Zero Trust → Access → Applications → Add → Self-hosted**: application domain
   `portal.afratech.africa`; policy *Allow* with *Emails* (the staff who may use it from outside) or *Emails ending
   in* your company domain. Login method: *One-time PIN*.

### 3. On the portal server (PowerShell as administrator)

```powershell
cd "C:\Program Files\StaffMobileKey\Platform"
.\set-tunnel-access.ps1 -Hostname portal.afratech.africa -Token <the token from step 2>
```

The script:
- adds the tunnel entrance to the gateway (127.0.0.1:8447) and checks the settings before using them;
- downloads `cloudflared` from Cloudflare's GitHub releases (or use `-CloudflaredExe <file>` with one you downloaded)
  and refuses it unless it is **signed by Cloudflare**;
- installs it as the Windows service **cloudflared** with your token (the token is kept by cloudflared only, never in
  the portal's files or logs);
- prints the **outside address** to give staff, and writes it where the portal finds it for invitation links.

```powershell
.\set-tunnel-access.ps1 -Show       # what is set
.\set-tunnel-access.ps1 -Disable    # switch it off (then delete the tunnel in Cloudflare)
```

With Cloudflare Access in front you may drop the secret path: `-NoSecretPath` (the address is then simply
`https://portal.afratech.africa`).

## Other options (for comparison)

| Option | Inbound opening at the hotel | Who runs what | Notes |
|---|---|---|---|
| **Cloudflare Tunnel** (this guide) | none | Cloudflare (free) | Easiest; TLS and certificates handled; optional e-mail PIN in front |
| Own relay server | none | you run a small VPS | No third party sees traffic; you patch and secure the VPS |
| WireGuard VPN | none (if the VPN server is outside) | you run the VPN | Strongest, but every user installs a VPN app |
| Public IP + port forward (`set-external-access.ps1`) | one TCP port | hotel IT | Refused at Bana; address allow-list + secret path |
