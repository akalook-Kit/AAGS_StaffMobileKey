/**
 * 2.9 Server settings an administrator manages in the portal instead of PowerShell:
 *  - passwords and keys (Credential Services account, SMTP password, SMS API key): set or remove only,
 *    never shown again (secret-store.ts);
 *  - database copies on the server: list, "Back up now".
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, one, many } from '../db.ts';
import { audit } from '../audit.ts';
import { requirePerm } from '../auth.ts';
import { getConfig } from '../hotel-config.ts';
import { deleteStoredSecret, envSecret, normRef, secretStoreEnabled, setStoredSecret, storedSecret } from '../secret-store.ts';
import { backupDir, backupNow, listBackups } from '../backup.ts';
import { ApiError, notFound } from '../lib/errors.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Hotel');
  return id;
};

/** The secrets a hotel's settings refer to, with what each one is for. Only these can be set. */
async function secretRefs(hotelId: string) {
  const cs = await getConfig(pool, hotelId, 'credential_services');
  const nt = await getConfig(pool, hotelId, 'notifications');
  const list: { ref: string; label: string; area: 'credential_services' | 'email' | 'sms'; masked: boolean }[] = [];
  if (cs) {
    list.push({ ref: normRef(cs.tenantUserRef), label: 'Credential Services user', area: 'credential_services', masked: false });
    list.push({ ref: normRef(cs.tenantPasswordRef), label: 'Credential Services password', area: 'credential_services', masked: true });
  }
  list.push({ ref: normRef(nt?.email?.passwordRef ?? 'SMTP_PASSWORD'), label: 'Mail server (SMTP) password', area: 'email', masked: true });
  list.push({ ref: normRef(nt?.sms?.secretRef ?? 'SMS_API_KEY'), label: 'SMS password or API key', area: 'sms', masked: true });
  return list;
}

export function serverRoutes(app: FastifyInstance) {
  app.get(`${P}/hotels/:hotelId/secrets`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'settings.manage');
    const refs = await secretRefs(hotelId);
    const rows = await many(pool, `SELECT s.ref, s.updated_at, o.display_name AS updated_by FROM platform_secrets s LEFT JOIN operators o ON o.id = s.updated_by WHERE s.hotel_id=$1`, [hotelId]);
    return {
      storeEnabled: secretStoreEnabled(),
      secrets: refs.map((r) => {
        const row = rows.find((x) => x.ref === r.ref);
        const fromServer = Boolean(envSecret(r.ref));
        return {
          ...r,
          source: fromServer ? 'server' : row && storedSecret(hotelId, r.ref) !== undefined ? 'portal' : row ? 'unreadable' : null,
          updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null,
        };
      }),
    };
  });

  app.put(`${P}/hotels/:hotelId/secrets/:ref`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const ref = normRef((req.params as any).ref);
    const allowed = await secretRefs(hotelId);
    const def = allowed.find((r) => r.ref === ref);
    if (!def) throw notFound('Password setting');
    if (envSecret(ref)) throw new ApiError(409, 'SECRET_FROM_SERVER', 'This value is set in the server\'s own settings and cannot be changed here.');
    const b = z.object({ value: z.string().min(1, 'Enter a value').max(400) }).parse(req.body);
    if (b.value.trim() !== b.value && !def.masked) throw new ApiError(400, 'VALIDATION', 'Remove the spaces at the start or end.');
    await setStoredSecret(hotelId, ref, b.value, op.id);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'secret.set', targetType: 'secret', targetId: ref, details: { label: def.label } });
    return { ok: true, ref };
  });

  app.delete(`${P}/hotels/:hotelId/secrets/:ref`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const ref = normRef((req.params as any).ref);
    const def = (await secretRefs(hotelId)).find((r) => r.ref === ref);
    if (!def) throw notFound('Password setting');
    await deleteStoredSecret(hotelId, ref);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'secret.removed', targetType: 'secret', targetId: ref, details: { label: def.label } });
    return { ok: true };
  });

  // ---- Database copies ------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/backups`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'settings.manage');
    const dir = backupDir();
    const size = await one(pool, 'SELECT pg_database_size(current_database())::bigint AS bytes');
    return { enabled: Boolean(dir), folder: dir, dailyAt: process.env.SMK_BACKUP_AT ?? '02:30', keep: Number(process.env.SMK_BACKUP_KEEP ?? 14), databaseBytes: Number(size!.bytes), copies: listBackups(dir).slice(0, 60) };
  });

  app.post(`${P}/hotels/:hotelId/backups`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    if (!backupDir()) throw new ApiError(409, 'BACKUP_OFF', 'Copies on this server are made by the hosting provider.');
    let r;
    try { r = await backupNow('manual'); } catch (e) { throw new ApiError(409, 'BACKUP_FAILED', (e as Error).message); }
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'database.backup', details: { file: r.file.split(/[\\/]/).pop(), bytes: r.bytes, sha256: r.sha256 } });
    return { name: r.file.split(/[\\/]/).pop(), bytes: r.bytes, sha256: r.sha256, tables: r.tables, rows: r.rows };
  });
}
