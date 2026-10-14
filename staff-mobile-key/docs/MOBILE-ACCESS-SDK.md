# ASSA ABLOY Mobile Access SDK: rules and notes for the staff app

This page records the information received from ASSA ABLOY Hospitality on 13 Oct about its Mobile Access
app and SDK. Follow these rules in the staff app: ASSA ABLOY must approve the app, and it does not approve
apps that break them.

## Where the SDK comes from

The SDK is distributed through ASSA ABLOY's **Hospitalitix** download portal. Use a link given to the
hotel by ASSA ABLOY; such a link is personal access, so:

- **never put the download link in Git**, the platform or any shared document;
- keep the downloaded files out of the repository.

The portal page seen on 13 Oct offered **"iOS 1.38"**, built with **SDK 7.6.7**. Its release notes said
"Keep display on whilst scanning" and "Bitcode enabled".

**A finished app build is not the SDK.** A version number like "iOS 1.38" usually means a finished app
build, made with SDK 7.6.7. To build the K Hotel staff app, you need the SDK itself and its integration
guide:

| Platform | What to get |
|---|---|
| Android | the library, usually an `.aar` file |
| iOS | the framework, usually an `.xcframework` |

You also need written confirmation from ASSA ABLOY of three things:

- that the licence covers a third-party, white-label app for K Hotel Bana;
- the application or "lock service" settings for K Hotel Bana's Mobile Access account (UUID 9, System ID 3460);
- the app-approval process.

## Scanning rules (app approval)

- **Seamless mode, as ASSA ABLOY defines it.** The phone opens the lock with no user action: screen off,
  phone in a pocket, app scanning in the background.
  - **This mode is generally not permitted.** An app must not scan continuously when it is not in the
    foreground, and certainly not with the screen off. Such apps are not approved.
  - Why: if the lock is transmitting over BLE and the phone is scanning, the door could open from
    *inside* the room.
- **What is allowed**
  - **Foreground use.** The staff app scans only after the user taps *Hold your phone near the lock*,
    while the app is open. This is what the app does today.
- **What can be approved**
  - **Controlled, timed seamless windows.** The SDK's seamless mode is switched on for a short, deliberate
    period. ASSA ABLOY's examples:
    - a tap on a watch app gives about 10 seconds of scanning;
    - beacons placed so the phone knows it is *outside* the room.
  - Each such design needs ASSA ABLOY's approval.
- **Seamless setting on the lock.** Turning on "seamless" in **Lock Service** only *allows* the lock to
  take part. It does not permit background scanning on the phone.

## Reading distance

The distance at which a phone may connect is set **on the lock**, in Lock Service, as a signal level. The
app cannot change it.

| Lock Service signal level | Approximate distance |
|---|---|
| -52 dBm | 1 m |
| -58 dBm | 1.5 m |
| -64 dBm | 3 m |
| -70 dBm | 5 m |

These distances are not exact. They vary, sometimes a lot, from door to door and phone to phone. For
staff doors, keep the distance short so a door is not opened from down the corridor. Test on the real
doors before choosing.

## What ASSA ABLOY's own Mobile Access app stores

This list is for comparison with our app and for the privacy text staff see.

| Data | Example |
|---|---|
| Device name | "John's iPhone" (from the phone's settings) |
| Guest email | johndoe@… |
| Check-in and check-out dates (UTC) | 2017-02-06T03:30:00Z |
| Common access list | Gym, sauna, spa |
| Hotel name, address, phone, web page, email | from the hotel's set-up |
| Hotel check-in and check-out times | 15:00, 12:00 |
| Key information | **encrypted** mobile-key metadata used to open the lock |
| Credential ID | 1000209 |

**Our staff app** keeps less:

- the sign-in token, in the phone's secure storage;
- the language setting.

It shows keys, tasks and hotel details fetched from the platform. The key itself stays inside the
ASSA ABLOY SDK's secure storage. The app never reads, copies or logs it.

## Integration checklist (when the SDK is in hand)

1. Add the SDK as a native module: an Expo config plugin and `npx expo prebuild`. This makes a
   development build; it will not run in Expo Go. Implement `apps/mobile/src/mobile-access/assaabloy.ts`:
   - `personalize()`: the SDK's invitation or endpoint set-up;
   - `listKeys()`: the SDK key store;
   - `openDoor()`: the SDK's open-closest-lock scanning, **started by the button and stopped after a
     short timeout**;
   - `readiness()`: Bluetooth, permissions and endpoint health.
2. Keep the display on while scanning, as in ASSA ABLOY's own 1.38 release.
3. Ask for only the permissions the SDK needs:
   - Bluetooth;
   - on Android, location, if the SDK requires it for BLE scanning on older versions.
4. Send the app to ASSA ABLOY for approval before any rollout to staff.
