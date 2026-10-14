import type { ExpoConfig } from 'expo/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One codebase, many branded editions (spec §5, §13.5). TENANT selects tenants/<tenant>/tenant.json,
 * which fixes the build-time identity: app name, bundle/package id, icons and splash.
 *   TENANT=k-hotel-bana npx expo start
 */
const tenant = process.env.TENANT ?? 'k-hotel-bana';
const t = JSON.parse(readFileSync(join(__dirname, 'tenants', tenant, 'tenant.json'), 'utf8'));

const config: ExpoConfig = {
  name: t.displayName,
  slug: t.slug,
  version: t.version,
  orientation: 'portrait',
  icon: t.icon,
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: t.iosBundleId,
    buildNumber: String(t.buildNumber),
    supportsTablet: false,
    infoPlist: {
      NSBluetoothAlwaysUsageDescription: 'Bluetooth is used to open hotel doors with your mobile key.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: t.androidPackage,
    versionCode: t.buildNumber,
    adaptiveIcon: { foregroundImage: t.adaptiveIcon, backgroundColor: t.primaryColor },
    permissions: ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'ACCESS_FINE_LOCATION'],
    allowBackup: false,
  },
  web: { bundler: 'metro' },
  plugins: ['expo-secure-store', ['expo-splash-screen', { image: t.splash, imageWidth: 180, backgroundColor: t.splashBackground }]],
  extra: { tenant: t.tenant, hotelCode: t.hotelCode },
};
export default config;
