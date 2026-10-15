# Staff Mobile Key Platform

White-label platform for issuing and managing **staff mobile keys** through an on-premises
**ASSA ABLOY Visionline** system. K Hotel Bana is the first tenant, branded with the K Hotel identity
(black and rose gold, logo in `brand/k-hotel/`); other hotels are added by
configuration, not by copying code.

Phase 1 (staff mobile keys) and Phase 2 (lock battery monitoring and maintenance requests) are implemented end to end and runs on your computer with a
**Visionline + Credential Services simulator**, so you can test every workflow before ASSA ABLOY
supplies the mobile SDK, a Credential Services tenant and test locks.

```
 Staff phone (Expo app)                     Admin web portal (React)
   │  HTTPS                                     │  HTTPS
   ▼                                            ▼
 ┌──────────────────────── Cloud backend (Fastify + PostgreSQL) ───────────────────────┐
 │ tenants · staff · roles/permissions · policy engine · approvals · command queue     │
 │ hash-chained audit trail · versioned branding/config · Credential Services adapter  │
 └───────────────▲──────────────────────────────────────────────────────▲──────────────┘
                 │ outbound HTTPS long-poll (no inbound ports)           │ callbacks (Basic auth)
 ┌───────────────┴─────────── Visionline PC (hotel network) ──┐   ┌─────┴──────────────────────┐
 │ Hotel connector (Windows service)                           │   │ ASSA ABLOY Credential      │
 │ HMAC-SHA1 signing · sessions · skew · encrypted journal     │   │ Services (cloud)           │
 │        │ https://127.0.0.1/api/v1                           │   └────────────┬───────────────┘
 │        ▼                                                    │                │ SEOS / BLE
 │ Visionline Web API ────────────── locks ◄───────────────────┼────────────────┘ phone at door
 └─────────────────────────────────────────────────────────────┘
```

| Folder | What it is |
|---|---|
| `apps/backend` | Cloud API, policy engine, command queue, audit, Credential Services adapter, jobs. Serves the portal. |
| `apps/portal` | Admin web portal: staff, mobile keys (door map), approvals, operators, connector health, app branding, settings, audit. |
| `apps/connector` | Hotel connector for the Visionline PC. Talks only to `https://127.0.0.1/api/v1` locally and out to the platform. |
| `apps/mobile` | Staff app (Expo / React Native) for Android and iPhone from one codebase. |
| `apps/simulator` | Development stand-in for Visionline Web API, Credential Services, the phone SDK and BLE locks. |
| `packages/shared` | Contracts shared by all parts: commands, roles/permissions, statuses, Visionline signing. |
| `scripts/e2e.ts` | End-to-end check of the acceptance gates. |
| `docs/` | Setup guide for Windows, upgrading, on-premises installation, management reports, hosting on Render, Phase 2 (battery and maintenance), the connector (how it works, Windows service, local test), read-only Visionline probe, Git, vendor-document mapping. |
| `scripts/windows/` | PowerShell helpers: check, start, stop, status, test, phone, visionline-probe, upgrade, rollback. |
| `brand/k-hotel/` | K Hotel logo and the interim app icon/splash made from it. |

## Quick start (Windows, macOS or Linux)

Full step-by-step instructions for a Windows PC that already runs other apps:
**[docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md)**. In short:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\windows\check.ps1     # Docker running? ports free? (changes nothing)
.\scripts\windows\start.ps1     # builds and starts; opens the portal
.\scripts\windows\test.ps1      # acceptance checks inside the container
.\scripts\windows\stop.ps1      # stop (data kept)
```

Newer versions install with a backup and can be rolled back: [docs/UPGRADING.md](docs/UPGRADING.md).

The project is isolated: containers, volumes, network and image are prefixed `khb-staffkey`, ports are
uncommon and set in `.env` (14080 / 14444 / 14090), bound to 127.0.0.1, and the database is not exposed.

| Open | Sign in |
|---|---|
| Portal http://localhost:14080 | `admin@khb.test`, `issuer@khb.test`, `security@khb.test`, `auditor@khb.test` — password `ChangeMe!2026` |
| Lock simulator http://localhost:14444 | — |
| Connector setup page http://localhost:14090 | user `admin`, password `local-admin` |
| Staff app (see docs) | `amina@khb.test`, `jean@khb.test`, `peter@khb.test`, `brice@khb.test` — password `Staff!2026` |
| Simulated Visionline operators | `sym` / `sym-dev-password`, `eric` / `eric-dev-password`, `sandra` / `sandra-dev-password` |

Developers can also run the services directly with Node.js 22 (`npm install`, `npm test`,
`npm run dev:simulator`, `dev:backend`, `dev:connector`, `npm run e2e`; backend on port 4000).

## Documentation

| Guide | For |
|---|---|
| [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md) | Installing the test environment on a Windows PC |
| [docs/UPGRADING.md](docs/UPGRADING.md) | Installing a newer version with a backup, and going back |
| [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md) | Hosting the platform on Render (Blueprint `render.yaml`), connector and app pointed at it |
| [docs/ON-PREMISES.md](docs/ON-PREMISES.md) | Installing everything on a hotel's Vingcard/Visionline server (any hotel); outside access by public IP and secret path, changeable with set-external-access.ps1 |
| [docs/MONITORING.md](docs/MONITORING.md) | Monitoring: doors offline, watched (VIP) doors, lock alarms, disk space and database size; alerts by e-mail and SMS; database copy tools |
| [docs/EVENT-LOG.md](docs/EVENT-LOG.md) | Event log (all / entrance / error events), PDF-only printing with the hotel header on every page, verifying a printed PDF |
| [docs/INSIGHTS.md](docs/INSIGHTS.md) | Management reports (keycards, user groups, lock alarms, battery life, maintenance) and the read-only Visionline directory read |
| [docs/BATTERY-MAINTENANCE.md](docs/BATTERY-MAINTENANCE.md) | Phase 2: lock battery monitoring and maintenance requests, roles, settings |
| [docs/MOBILE-ACCESS-SDK.md](docs/MOBILE-ACCESS-SDK.md) | ASSA ABLOY Mobile Access SDK: where it comes from, scanning rules for app approval, reading distance, integration checklist |
| [docs/CONNECTOR-WINDOWS-SERVICE.md](docs/CONNECTOR-WINDOWS-SERVICE.md) | What the connector is, how it talks to Visionline, installing it on the Visionline PC |
| [docs/CONNECTOR-LOCAL-TEST.md](docs/CONNECTOR-LOCAL-TEST.md) | Running the real connector service on your own PC against the simulator |
| [docs/VISIONLINE-PROBE.md](docs/VISIONLINE-PROBE.md) | Read-only check of a real Visionline server |
| [docs/GIT.md](docs/GIT.md) | Putting the project in a private Git repository |
| [docs/K-HOTEL-BANA.md](docs/K-HOTEL-BANA.md) | K Hotel Bana's Visionline and Credential Services values, and the read-only account check |
| [docs/VENDOR-MAPPING.md](docs/VENDOR-MAPPING.md) | Every Visionline / Credential Services call and its document section |

## What is verified against the ASSA ABLOY documents

The Visionline adapter follows **Web API 61 1100 080 rev 74** and the Credential Services adapter
follows **AAH Credential Services API V2.5.1**. Request signing is tested byte-for-byte against the
worked examples in the Web API document (§7.1.3, §7.1.4). Open points that the documents do not
settle for *staff* keys are listed in [docs/VENDOR-MAPPING.md](docs/VENDOR-MAPPING.md) and shown in
the portal under **Connector health → Waiting for ASSA ABLOY confirmation**.

## What still needs ASSA ABLOY before a real door opens

1. The licensed **Mobile Access SDK** for Android and iOS (replaces `apps/mobile/src/mobile-access/simulated.ts`).
2. A **Credential Services** tenant (base URL, tenant user/password, system ID).
3. A **Visionline Web API operator**, access ID / web client, certificate trust, and the mobile access (TLCode) option.
4. Non-production test locks and phones, and written answers to the open points in `docs/VENDOR-MAPPING.md`.

## Security notes

- Visionline and Credential Services secrets never reach the phone. Visionline operator passwords typed in
  the portal are encrypted in the browser with the connector's public key; the platform only relays the
  sealed blob, and they live only in the connector's encrypted store (DPAPI-protected key on Windows).
- The connector opens no inbound ports; it validates the Visionline certificate (CA file and/or pin).
- Every key request needs an `Idempotency-Key`; Visionline's one-staff-card rule is enforced before sending.
- Broad access requires a second person (separation of duties) and a shorter validity.
- The audit trail is append-only (database trigger) and hash-chained; integrity can be checked from the portal.
- Development defaults (passwords, tokens, JWT secret) are for local testing only — replace all of them for any pilot.
