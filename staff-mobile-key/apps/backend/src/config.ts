const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing environment variable ${k}`);
  return v;
};

export const config = {
  port: Number(env('PORT', '4000')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://smk:smk@localhost:5432/smk'),
  /** HS256 key for operator and staff session tokens. Use a managed secret in production. */
  jwtSecret: env('JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789'),
  /** Base URL that Credential Services can reach for callbacks (public HTTPS in production). */
  publicUrl: env('PUBLIC_URL', process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4000'), // Render sets RENDER_EXTERNAL_URL
  /** Used to derive per-hotel Basic-auth passwords for Credential Services callbacks. */
  callbackSecret: env('CALLBACK_SECRET', 'dev-callback-secret'),
  portalDist: env('PORTAL_DIST', '../portal/dist'),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(','),
  connectorOfflineAfterSec: Number(env('CONNECTOR_OFFLINE_AFTER_SEC', '60')),
  commandTtlSec: Number(env('COMMAND_TTL_SEC', '600')),
  /** "on": Credential Services calls this platform back (needs a public address). "off": nothing comes in from
   *  the internet; the platform asks Credential Services for endpoint and credential status instead (on-premises). */
  csCallbacks: env('CS_CALLBACKS', 'on') === 'off' ? 'off' as const : 'on' as const,
  isDev: env('NODE_ENV', 'development') !== 'production',
};

// A hosted platform must never run with the development secrets or an http:// public address.
if (!config.isDev) {
  const problems: string[] = [];
  if (config.jwtSecret.startsWith('dev-') || config.jwtSecret.length < 32) problems.push('JWT_SECRET must be a random value of 32+ characters');
  if (config.callbackSecret.startsWith('dev-') || config.callbackSecret.length < 32) problems.push('CALLBACK_SECRET must be a random value of 32+ characters');
  if (config.csCallbacks === 'on' && !config.publicUrl.startsWith('https://')) problems.push('PUBLIC_URL must be the public https:// address of this platform (or set CS_CALLBACKS=off)');
  if (problems.length) throw new Error(`Refusing to start in production: ${problems.join('; ')}.`);
}

/**
 * Secrets are referenced by name from configuration and resolved here, never stored in the database
 * or returned to a browser. Development: environment variables SECRET_<REF>. Production: replace with
 * a managed secret store (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault).
 */
export function getSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return process.env[`SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
}
