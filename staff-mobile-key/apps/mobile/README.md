# Staff app (Expo / React Native)

One codebase for Android and iPhone. Hotel identity is chosen at build time from
`tenants/<tenant>/tenant.json` (name, bundle id, icons, splash). Colours, logo and wording come from the
portal at runtime (**Mobile app settings**), so they change without a new release.

Easiest on Windows: `..\..\scripts\windows\phone.ps1` (see docs/WINDOWS-SETUP.md, Step 10). By hand:

```powershell
npm install
$env:EXPO_PUBLIC_API_URL="http://<your-PC-IP>:14080"
$env:EXPO_PUBLIC_SIM_URL="http://<your-PC-IP>:14444"   # simulated SDK only
npx expo start --port 14081 --lan                       # scan the QR code with Expo Go
```

## Adding another hotel edition

1. Copy `tenants/k-hotel-bana` to `tenants/<new-hotel>` and edit `tenant.json` and the images.
2. `TENANT=<new-hotel> npx expo start` (or set `TENANT` in the build pipeline).

## Mobile access SDK

`src/mobile-access/` is the only code that touches keys. In development it uses the simulator
(`simulated.ts`). The licensed ASSA ABLOY Mobile Access SDK replaces it in `assaabloy.ts`; that needs
a development build (`npx expo prebuild`, then Android Studio / Xcode on a Mac, or EAS Build), not Expo Go.
Set `EXPO_PUBLIC_MOBILE_ACCESS=assaabloy` for those builds.

## Release builds (later)

- Android pilot: signed APK; production: signed App Bundle for Google Play.
- iPhone: signed archive via TestFlight, then App Store or an Apple-approved private channel (needs a Mac or EAS Build).
