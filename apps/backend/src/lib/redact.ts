/** Removes values that must never reach logs or the audit trail (spec §13.3). */
const SECRET_KEYS = /^(password|confirmPin|pin|secret|token|accessKey|authorization|invitationCode|credential|totpSecret|totp_secret|password_hash|token_hash)$/i;

export function redact<T>(v: T): T {
  if (v instanceof Date) return v.toISOString() as T;
  if (Array.isArray(v)) return v.map(redact) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(x);
    return o as T;
  }
  return v;
}

/** Deterministic JSON with sorted keys, so hashes survive a jsonb round-trip. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stableStringify((v as any)[k])).join(',') + '}';
}
