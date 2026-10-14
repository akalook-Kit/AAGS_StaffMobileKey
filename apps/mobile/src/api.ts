import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

// Session token in platform secure storage (Keychain / Android Keystore). Web preview keeps it in memory.
const KEY = 'smk_staff_token';
let memory: string | null = null;
export const tokenStore = {
  async get() { return Platform.OS === 'web' ? memory : SecureStore.getItemAsync(KEY); },
  async set(v: string | null) {
    if (Platform.OS === 'web') { memory = v; return; }
    if (v) await SecureStore.setItemAsync(KEY, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    else await SecureStore.deleteItemAsync(KEY);
  },
};

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const token = await tokenStore.get();
  let r: Response;
  try {
    r = await fetch(API_URL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'No connection to the hotel service. Check Wi-Fi or mobile data. Keys already on your phone still work at the locks.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? `Request failed (${r.status})`);
  return j as T;
}
