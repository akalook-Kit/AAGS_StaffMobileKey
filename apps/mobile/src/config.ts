import Constants from 'expo-constants';

/**
 * Where the app finds the platform. On a phone, "localhost" is the phone itself, so set
 * EXPO_PUBLIC_API_URL to your computer's LAN address, e.g. http://192.168.1.20:4000
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
/** Simulated vendor SDK only: where the Credential Services / lock simulator runs. */
export const SIM_URL = (process.env.EXPO_PUBLIC_SIM_URL ?? 'http://localhost:8444').replace(/\/$/, '');
/** 'simulated' until the ASSA ABLOY SDK is licensed and integrated (see src/mobile-access/README.md). */
export const MOBILE_ACCESS_MODE = (process.env.EXPO_PUBLIC_MOBILE_ACCESS ?? 'simulated') as 'simulated' | 'assaabloy';
export const HOTEL_CODE: string = (Constants.expoConfig?.extra as any)?.hotelCode ?? 'default'; // "default" = the hotel of the server the app talks to
