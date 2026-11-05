/**
 * 2.14 Staff keycards: requests (portal or QR code page), issuing them in Visionline (encoded at an encoder from the
 * portal, or issued from Visionline and recorded here), the keycard register (HK 001…), returns on resignation (the
 * returned card is overwritten with a card that dies a minute later; a lost card is cancelled by its number), e-mails
 * to HR and the security manager, renewal reminders and holders with more than one card. Also the unpaid-guest
 * lock-out (front office asks, a manager approves; checkout command to an online lock or a 1-minute override card for
 * an offline lock) and the encoders list. Visionline stays the key system: every card is made in Visionline.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { pool, many, one, tx } from '../db.ts';
import { audit } from '../audit.ts';
import { permsIn, requireOperator, requirePerm } from '../auth.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { getConfig, saveConfig } from '../hotel-config.ts';
import { importedForSetupReport } from './vl-imports.ts';
import { visionlineGlance } from '../vl-reports.ts';
import { sharedVisionlineOperator, ROLE_LABELS } from '@smk/shared';
import { genericCards } from '../generic-cards.ts';
import { enqueue, newCorrelationId } from '../commands.ts';
import { channels } from '../monitoring/monitor.ts';
import { sendEmail } from '../monitoring/channels.ts';
import { onKeycardExtended } from '../keycard-check.ts';
import { buildAccountsReport, requestGuestCardRead, sendAccountsReport } from '../accounts-report.ts';

const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const uuid = z.string().uuid();
const Label = z.string().trim().toUpperCase().regex(/^[A-Z]{1,6}[ -]?\d{1,5}$/, 'Card number like HK 001');
const normLabel = (l: string) => l.replace(/^([A-Z]+)[ -]?(\d+)$/, (_m, a, d) => `${a} ${d.padStart(3, '0')}`);

async function kcPolicy(hotelId: string) {
  const p = (await getConfig(pool, hotelId, 'policy'))?.keycards ?? {};
  return { hrEmail: null as string | null, notifyEmails: [] as string[], notifySecurityManagers: true, encodeEnabled: false, encoders: [] as string[],
    dailyUserGroup: null as string | null, dailyHours: 14, permanentDays: 365, labelPrefixes: ['HK', 'FO', 'FB', 'ENG', 'SEC', 'ADM'], requestToken: null as string | null, ...p };
}

/** E-mail HR / the security manager(s); failures never block the work, they are recorded on the request. */
async function notify(hotelId: string, who: ('hr' | 'security')[], subject: string, text: string) {
  const pol = await kcPolicy(hotelId);
  const to = new Set<string>();
  if (who.includes('hr') && pol.hrEmail) to.add(pol.hrEmail);
  if (who.includes('security')) {
    for (const e of pol.notifyEmails) to.add(e);
    if (pol.notifySecurityManagers) for (const r of await many(pool, `SELECT DISTINCT o.email FROM operators o JOIN memberships m ON m.operator_id=o.id WHERE m.hotel_id=$1 AND m.role='SECURITY_MANAGER' AND o.status='ACTIVE'`, [hotelId])) to.add(r.email);
  }
  const ch = await channels(hotelId);
  const out: { to: string; ok: boolean; at: string; error?: string }[] = [];
  for (const t of to) {
    if (!ch.email?.enabled) { out.push({ to: t, ok: false, at: new Date().toISOString(), error: 'E-mail is not set up (Settings -> Alerts & notifications)' }); continue; }
    try { await sendEmail(ch.email, t, subject, text, hotelId); out.push({ to: t, ok: true, at: new Date().toISOString() }); }
    catch (e) { out.push({ to: t, ok: false, at: new Date().toISOString(), error: (e as Error).message.slice(0, 160) }); }
  }
  return out;
}

const Request = z.object({
  kind: z.enum(['new', 'replacement', 'cancel']),
  staffType: z.enum(['permanent', 'daily']).default('permanent'),
  givenName: z.string().trim().min(1).max(60), surname: z.string().trim().min(1).max(60),
  department: z.string().trim().min(1).max(80), jobTitle: z.string().trim().max(80).optional().nullable(),
  employeeNo: z.string().trim().max(40).optional().nullable(),
  cardLabel: Label.optional().nullable(),
  quantity: z.number().int().min(1).max(50).default(1),
  // 2.20 An expiry date chosen on the form: in the future and at most ten years ahead.
  validUntil: z.string().datetime().optional().nullable()
    .refine((v) => !v || (Date.parse(v) > Date.now() && Date.parse(v) < Date.now() + 3653 * 86_400_000), 'The expiry date must be in the future (at most ten years ahead).'),
  reason: z.string().trim().min(2).max(300),
  managerName: z.string().trim().min(2).max(80),
  hrEmail: z.string().email().optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  vlUserId: z.string().max(200).optional().nullable(),
  cardRegNo: z.string().regex(/^\d{1,12}$/).optional().nullable(),
});
type RequestIn = z.infer<typeof Request>;

async function nextNumber(c: pg.PoolClient | typeof pool, hotelId: string) {
  const y = new Date().getFullYear();
  const r = await one(c, `SELECT count(*)::int AS n FROM keycard_requests WHERE hotel_id=$1 AND number LIKE $2`, [hotelId, `KR${y}-%`]);
  return `KR${y}-${String((r?.n ?? 0) + 1).padStart(4, '0')}`;
}
const hist = (by: string, what: string) => JSON.stringify([{ at: new Date().toISOString(), by, what }]);

async function createRequest(hotelId: string, b: RequestIn, source: 'portal' | 'qr', opId: string | null, by: string) {
  if (b.staffType === 'daily' && b.kind !== 'cancel' && b.cardLabel == null) { /* daily cards may be unnumbered */ }
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kr:${hotelId}`]);
    const number = await nextNumber(c, hotelId);
    const r = await one(c, `INSERT INTO keycard_requests (hotel_id, number, kind, staff_type, status, given_name, surname, department, job_title, employee_no, card_label, quantity,
        valid_until, reason, manager_name, hr_email, note, source, vl_user_id, card_reg_no, requested_by, history)
      VALUES ($1,$2,$3,$4,'SUBMITTED',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [hotelId, number, b.kind, b.staffType, b.givenName, b.surname, b.department, b.jobTitle ?? null, b.employeeNo ?? null, b.cardLabel ? normLabel(b.cardLabel) : null, b.quantity,
        b.validUntil ?? null, b.reason, b.managerName, b.hrEmail ?? null, b.note ?? null, source, b.vlUserId ?? null, b.cardRegNo ?? null, opId, hist(by, `Requested (${source === 'qr' ? 'QR code page' : 'portal'})`)]);
    await audit(c, { hotelId, actorType: opId ? 'operator' : 'system', actorId: opId, action: 'keycard.requested', targetType: 'keycard_request', targetId: r!.id,
      details: { number, kind: b.kind, staffType: b.staffType, name: `${b.givenName} ${b.surname}`, department: b.department, manager: b.managerName, source } });
    return r!;
  });
}

const out = (r: any) => ({
  id: r.id, number: r.number, kind: r.kind, staffType: r.staff_type, status: r.status, givenName: r.given_name, surname: r.surname, department: r.department, jobTitle: r.job_title,
  employeeNo: r.employee_no, cardLabel: r.card_label, quantity: r.quantity, validUntil: r.valid_until, reason: r.reason, managerName: r.manager_name, hrEmail: r.hr_email, note: r.note,
  source: r.source, vlUserId: r.vl_user_id, cardRegNo: r.card_reg_no, issueMethod: r.issue_method, returnState: r.return_state, cancelMethod: r.cancel_method, commandId: r.command_id,
  userGroup: r.user_group, history: r.history, notified: r.notified, createdAt: r.created_at, updatedAt: r.updated_at, requestedBy: r.requested_by_name ?? null,
  // 2.21 Who issued the card (portal user), when, and the Visionline operator who made it when it was made in Visionline.
  issuedBy: r.issued_by_name ?? null, issuedAt: r.issued_at ?? null, vlOperator: r.vl_operator ?? null,
});
const SEL = `SELECT k.*, o.display_name AS requested_by_name, ib.display_name AS issued_by_name FROM keycard_requests k LEFT JOIN operators o ON o.id=k.requested_by LEFT JOIN operators ib ON ib.id=k.issued_by`;

/** 2.21 The Visionline operator a portal user works as: linked by an administrator, or their own verified Visionline sign-in. */
export async function vlOperatorOf(hotelId: string, operatorId: string): Promise<string | null> {
  const r = await one(pool, `SELECT vl_operator AS name FROM vl_operator_links WHERE hotel_id=$1 AND operator_id=$2
    UNION ALL SELECT username FROM operator_vl_credentials WHERE hotel_id=$1 AND operator_id=$2 AND status='VERIFIED' LIMIT 1`, [hotelId, operatorId]);
  return r?.name ?? null;
}

/** Visionline user id for a person: their existing Visionline user, or one made from the request number. */
const holderId = (r: any) => r.vl_user_id ?? `kr-${r.number.toLowerCase()}`;

/** Results of encoder / cancel commands sent for a request (called when the connector reports back). */
export async function onKeycardCommandResult(c: pg.PoolClient, cmd: any, result: { status: string; result?: any; error?: any }) {
  // 2.17 Who encoded each keycard from the portal (the Visionline Web API does not say who encoded a card).
  if (cmd.type === 'ENCODE_KEYCARD' && result.status === 'SUCCEEDED' && result.result?.regNo) {
    await c.query(`INSERT INTO portal_encoded_cards (hotel_id, reg_no, kind, operator_id, operator_name, command_id)
        VALUES ($1,$2,$3,$4,(SELECT display_name FROM operators WHERE id=$4),$5)
      ON CONFLICT (hotel_id, reg_no) DO UPDATE SET kind=EXCLUDED.kind, operator_id=EXCLUDED.operator_id, operator_name=EXCLUDED.operator_name, encoded_at=now(), command_id=EXCLUDED.command_id`,
      [cmd.hotel_id, String(result.result.regNo), cmd.payload?.kind ?? 'staff', cmd.requested_by ?? null, cmd.id]);
  }
  const ctx = cmd.payload?.context as { requestId?: string; step?: string; lockoutId?: string } | undefined;
  if ((ctx as any)?.step === 'extend') { await onKeycardExtended(c, cmd, result); return; }
  if ((ctx as any)?.departureDay) {
    const ok = result.status === 'SUCCEEDED';
    for (const x of (result.result?.results ?? []) as any[]) await c.query(`UPDATE departure_checks SET status=$4 WHERE hotel_id=$1 AND day=$2 AND room=$3 AND status='SENT'`, [cmd.hotel_id, (ctx as any).departureDay, x.door, x.ok ? 'REACHED' : 'FAILED']);
    if (!ok) await c.query(`UPDATE departure_checks SET status='FAILED' WHERE hotel_id=$1 AND command_id=$2 AND status='SENT'`, [cmd.hotel_id, cmd.id]);
    return;
  }
  if (ctx?.lockoutId) {
    const ok = result.status === 'SUCCEEDED' && (cmd.type !== 'DOOR_COMMANDS' || (result.result?.results ?? []).some((x: any) => x.ok));
    await c.query(`UPDATE guest_lockouts SET status=$3, updated_at=now(), history = history || $4::jsonb WHERE id=$1 AND hotel_id=$2`,
      [ctx.lockoutId, cmd.hotel_id, ok ? 'DONE' : 'FAILED', hist('Visionline', ok ? (cmd.type === 'DOOR_COMMANDS' ? 'Checkout command reached the online lock' : 'Blocking card encoded: place it in the lock') : `Failed: ${result.error?.message ?? 'no answer'}`)]);
    return;
  }
  if (!ctx?.requestId) return;
  const r = await one(c, 'SELECT * FROM keycard_requests WHERE id=$1 AND hotel_id=$2 FOR UPDATE', [ctx.requestId, cmd.hotel_id]);
  if (!r) return;
  if (result.status !== 'SUCCEEDED') {
    await c.query(`UPDATE keycard_requests SET history = history || $2::jsonb, updated_at=now() WHERE id=$1`, [r.id, hist('Visionline', `Failed (${ctx.step}): ${result.error?.message ?? 'no answer'}`)]);
    return;
  }
  if (ctx.step === 'issue') {
    const reg = result.result?.regNo ?? null;
    await c.query(`UPDATE keycard_requests SET status='ISSUED', card_reg_no=COALESCE($2, card_reg_no), vl_user_id=COALESCE(vl_user_id,$3), issued_count=issued_count+1, updated_at=now(), issued_at=now(),
        history = history || $4::jsonb WHERE id=$1`, [r.id, reg, cmd.payload.cardHolder, hist('Visionline', `Encoded at ${cmd.payload.encoder}${reg ? `, card ${reg}` : ''}`)]);
    if (r.card_label) await upsertRegister(c, cmd.hotel_id, r.card_label, { department: r.department, staffType: r.staff_type, holder: `${r.given_name} ${r.surname}`, vlUserId: cmd.payload.cardHolder, regNo: reg, status: 'in_use', requestId: r.id });
  } else if (ctx.step === 'collect') {
    await c.query(`UPDATE keycard_requests SET status='COLLECTED', updated_at=now(), history = history || $2::jsonb WHERE id=$1`, [r.id, hist('Visionline', cmd.type === 'CANCEL_KEYCARD' ? 'Card cancelled in Visionline' : 'Returned card overwritten: it stops working within a minute')]);
    if (r.card_label) await c.query(`UPDATE keycard_register SET status=$3, updated_at=now() WHERE hotel_id=$1 AND label=$2`, [cmd.hotel_id, r.card_label, r.return_state === 'returned' ? 'returned' : r.return_state === 'lost' ? 'lost' : 'cancelled']);
    setImmediate(() => void (async () => {
      const sent = await notify(cmd.hotel_id, ['hr', 'security'], `Keycard ${r.card_label ?? r.card_reg_no ?? ''} cancelled - ${r.given_name} ${r.surname}`,
        `${r.given_name} ${r.surname} (${r.department}${r.employee_no ? `, ${r.employee_no}` : ''})\nKeycard ${r.card_label ?? ''} ${r.card_reg_no ? `(Visionline card ${r.card_reg_no})` : ''}\n` +
        `Card ${r.return_state === 'returned' ? 'returned and cancelled' : r.return_state === 'lost' ? 'reported lost and cancelled' : 'cancelled'} in Visionline.\nRequest ${r.number}. Reason: ${r.reason}`);
      await pool.query(`UPDATE keycard_requests SET notified = notified || $2::jsonb WHERE id=$1`, [r.id, JSON.stringify(sent)]);
    })().catch(() => undefined));
  }
}

async function upsertRegister(c: pg.PoolClient | typeof pool, hotelId: string, label: string, v: { department?: string | null; staffType: string; holder: string | null; vlUserId: string | null; regNo: string | null; status: string; requestId: string | null }) {
  await c.query(`INSERT INTO keycard_register (hotel_id, label, department, staff_type, holder_name, vl_user_id, card_reg_no, status, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (hotel_id, label) DO UPDATE SET department=COALESCE(EXCLUDED.department, keycard_register.department), staff_type=EXCLUDED.staff_type, holder_name=EXCLUDED.holder_name,
      vl_user_id=EXCLUDED.vl_user_id, card_reg_no=COALESCE(EXCLUDED.card_reg_no, keycard_register.card_reg_no), status=EXCLUDED.status, request_id=EXCLUDED.request_id, updated_at=now()`,
    [hotelId, label, v.department ?? null, v.staffType, v.holder, v.vlUserId, v.regNo, v.status, v.requestId]);
}

/** 2.14 Once a day: e-mail the people in charge (security managers, the notify list, HR) about staff keycards that end
 *  within 14 days, so they are renewed in time. */
const remindedOn = new Map<string, string>();
export async function maybeSendRenewalReminders() {
  for (const h of await many(pool, `SELECT id FROM hotels`)) {
    const day = new Date().toISOString().slice(0, 10);
    if (remindedOn.get(h.id) === day) continue;
    const pol = await kcPolicy(h.id);
    if (!pol.encodeEnabled && !pol.hrEmail && !pol.notifyEmails.length) continue;
    remindedOn.set(h.id, day);
    const rows = await many(pool, `SELECT c.reg_no, c.user_group, c.expires_at, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS name, g.label
        FROM vl_cards c LEFT JOIN vl_users u ON u.hotel_id=c.hotel_id AND u.user_id=c.card_holder LEFT JOIN keycard_register g ON g.hotel_id=c.hotel_id AND g.card_reg_no=c.reg_no
        WHERE c.hotel_id=$1 AND c.active AND NOT c.cancelled AND c.key_id IS NULL AND c.expires_at BETWEEN now() AND now() + interval '14 days' ORDER BY c.expires_at LIMIT 200`, [h.id]);
    if (!rows.length) continue;
    await notify(h.id, ['hr', 'security'], `${rows.length} staff keycard(s) end within 14 days`,
      ['These staff keycards end soon. Ask the managers to request a renewal (Staff keycards -> New request -> Replacement):', '',
        ...rows.map((r) => `  ${r.expires_at.toISOString().slice(0, 10)}  ${r.label ?? r.reg_no}  ${r.name ?? ''}  (${r.user_group ?? ''})`)].join('\n')).catch(() => undefined);
  }
}

const qrHits = new Map<string, { n: number; since: number }>();
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

const SETUP_REPORT_LIMIT_MS = Number(process.env.SMK_SETUP_REPORT_LIMIT_MS ?? 90_000);

export function keycardRoutes(app: FastifyInstance) {
  const base = `${P}/hotels/:hotelId/keycards`;

  // ---- Public QR page (no sign-in; the link carries a secret the administrator can change) ----------------------
  const findByToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('Request page');
    const r = await one(pool, `SELECT v.hotel_id, h.name FROM hotel_config_versions v JOIN hotels h ON h.id=v.hotel_id
        WHERE v.kind='policy' AND v.version = (SELECT max(version) FROM hotel_config_versions x WHERE x.hotel_id=v.hotel_id AND x.kind='policy')
        AND v.data->'keycards'->>'requestTokenHash' = $1`, [tokenHash(token)]);
    if (!r) throw notFound('Request page');
    return r;
  };
  app.get(`${P}/public/keycard-requests/:token`, async (req) => {
    const h = await findByToken((req.params as any).token);
    const pol = await kcPolicy(h.hotel_id);
    const depts = await many(pool, `SELECT DISTINCT user_group AS d FROM vl_users WHERE hotel_id=$1 AND active AND user_group IS NOT NULL ORDER BY 1 LIMIT 100`, [h.hotel_id]);
    return { hotel: h.name, departments: depts.map((d) => d.d), labelPrefixes: pol.labelPrefixes };
  });
  app.post(`${P}/public/keycard-requests/:token`, async (req, reply) => {
    const h = await findByToken((req.params as any).token);
    const k = req.ip;
    const f = qrHits.get(k);
    if (f && Date.now() - f.since < 3_600_000 && f.n >= 15) throw new ApiError(429, 'TOO_MANY', 'Too many requests from this device. Try again later or ask front office.');
    if (!f || Date.now() - f.since >= 3_600_000) qrHits.set(k, { n: 1, since: Date.now() }); else f.n++;
    if (qrHits.size > 20_000) qrHits.clear();
    const b = Request.omit({ vlUserId: true, cardRegNo: true }).parse(req.body);
    const r = await createRequest(h.hotel_id, b, 'qr', null, `${b.managerName} (QR page)`);
    setImmediate(() => void notify(h.hotel_id, ['security'], `Keycard request ${r.number} - ${b.givenName} ${b.surname}`, `${b.kind === 'cancel' ? 'Cancellation' : b.kind === 'replacement' ? 'Replacement' : 'New keycard'} for ${b.givenName} ${b.surname} (${b.department}, ${b.staffType}).\nAsked by ${b.managerName}: ${b.reason}\nOpen Keycards in the portal to handle it.`).catch(() => undefined));
    return reply.code(201).send({ number: r.number, status: r.status });
  });
  app.post(`${base}/qr-link`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.manage');
    const token = randomBytes(18).toString('base64url');
    const pol = (await getConfig(pool, hotelId, 'policy')) ?? {};
    await tx(async (c) => {
      await saveConfig(c, hotelId, 'policy', { ...pol, keycards: { ...(pol.keycards ?? {}), requestTokenHash: tokenHash(token) } }, op.id);
      await audit(c, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.request_link_changed' });
    });
    // The link is shown once (only its fingerprint is kept); a new link stops the old one.
    return { path: `/request/${token}` };
  });

  // ---- Requests --------------------------------------------------------------------------------------------------
  app.get(`${base}/requests`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    const perms = permsIn(op, hotelId);
    if (!perms.has('keycards.read') && !perms.has('keycards.request')) throw forbidden();
    const q = z.object({ status: z.string().max(20).optional(), q: z.string().max(60).optional() }).parse(req.query);
    const mine = !perms.has('keycards.read');
    const rows = await many(pool, `${SEL} WHERE k.hotel_id=$1 AND ($2::text IS NULL OR k.status=$2) AND ($3::uuid IS NULL OR k.requested_by=$3)
        AND ($4::text IS NULL OR k.given_name ILIKE $4 OR k.surname ILIKE $4 OR k.number ILIKE $4 OR k.card_label ILIKE $4 OR k.department ILIKE $4)
        ORDER BY (k.status='SUBMITTED') DESC, k.created_at DESC LIMIT 500`, [hotelId, q.status ?? null, mine ? op.id : null, q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null]);
    return rows.map(out);
  });
  app.post(`${base}/requests`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.request');
    const b = Request.parse(req.body);
    const r = await createRequest(hotelId, b, 'portal', op.id, op.displayName);
    setImmediate(() => void notify(hotelId, ['security'], `Keycard request ${r.number} - ${b.givenName} ${b.surname}`, `${b.kind} keycard for ${b.givenName} ${b.surname} (${b.department}). Asked by ${op.displayName} for ${b.managerName}: ${b.reason}`).catch(() => undefined));
    return reply.code(201).send(out(r));
  });
  const load = async (hotelId: string, id: string) => {
    const r = await one(pool, `${SEL} WHERE k.hotel_id=$1 AND k.id=$2`, [hotelId, uuid.parse(id)]);
    if (!r) throw notFound('Request');
    return r;
  };
  app.post(`${base}/requests/:id/reject`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.manage');
    const r = await load(hotelId, (req.params as any).id);
    const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    if (r.status !== 'SUBMITTED') throw conflict('NOT_OPEN', 'Only a submitted request can be rejected.');
    await pool.query(`UPDATE keycard_requests SET status='REJECTED', handled_by=$2, updated_at=now(), history = history || $3::jsonb WHERE id=$1`, [r.id, op.id, hist(op.displayName, `Rejected: ${b.reason}`)]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.rejected', targetType: 'keycard_request', targetId: r.id, details: { number: r.number, reason: b.reason } });
    return { ok: true };
  });

  /**
   * Issue: encoded at an encoder from the portal (Visionline makes the card, the holder is created in Visionline if
   * needed), or recorded as issued from Visionline (with the Visionline operator). Permanent staff need the hotel's card number (HK 001).
   */
  app.post(`${base}/requests/:id/issue`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.manage');
    const r = await load(hotelId, (req.params as any).id);
    const b = z.object({
      method: z.enum(['encoder', 'visionline_desk', 'existing']), encoder: z.string().regex(/^[\w .-]{1,40}$/).optional(),
      /** 2.17 The person already exists in Visionline (their user id), so no duplicate is created. */
      vlUserId: z.string().trim().min(1).max(80).optional().nullable(),
      cardLabel: Label.optional().nullable(), userGroup: z.string().min(1).max(60), doorIds: z.array(z.string().max(100)).max(2000).default([]),
      /** 2.21 Issued from Visionline: the Visionline operator who made the card (default: the user's own operator). */
      vlOperator: z.string().trim().min(1).max(80).optional().nullable(),
      validUntil: z.string().datetime().optional().nullable().refine((v) => !v || (Date.parse(v) > Date.now() && Date.parse(v) < Date.now() + 3653 * 86_400_000), 'The expiry date must be in the future (at most ten years ahead).'), regNo: z.string().regex(/^\d{1,12}$/).optional().nullable(), replaceExisting: z.boolean().default(false),
    }).parse(req.body);
    if (!['SUBMITTED', 'ISSUED'].includes(r.status) || r.kind === 'cancel') throw conflict('NOT_ISSUABLE', 'This request is not waiting for a keycard.');
    const label = b.cardLabel ? normLabel(b.cardLabel) : r.card_label;
    if (r.staff_type === 'permanent' && !label) throw badRequest('LABEL_REQUIRED', 'Permanent staff need the card number (for example HK 001).');
    const pol = await kcPolicy(hotelId);
    const until = b.validUntil ?? r.valid_until?.toISOString?.() ?? new Date(Date.now() + (r.staff_type === 'daily' ? pol.dailyHours * 3_600_000 : pol.permanentDays * 86_400_000)).toISOString();
    if (label) {
      const used = await one(pool, `SELECT holder_name FROM keycard_register WHERE hotel_id=$1 AND label=$2 AND status='in_use' AND request_id IS DISTINCT FROM $3`, [hotelId, label, r.id]);
      if (used) throw conflict('LABEL_IN_USE', `Card ${label} is already held by ${used.holder_name}. Record its return first, or use another number.`);
    }
    // 2.17 An existing Visionline keycard: the request is linked to it, nothing is encoded.
    if (b.method === 'existing') {
      if (!b.regNo) throw badRequest('CARD_REQUIRED', 'Choose the existing keycard.');
      const k = await one(pool, `SELECT k.reg_no, k.card_holder, COALESCE(u.user_group, k.user_group) AS user_group, k.expires_at FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
        WHERE k.hotel_id=$1 AND k.reg_no=$2`, [hotelId, b.regNo]);
      if (!k) throw badRequest('UNKNOWN_CARD', 'This keycard is not in the list read from Visionline.');
      await pool.query(`UPDATE keycard_requests SET status='ISSUED', card_label=$2, user_group=$3, valid_until=COALESCE($4, valid_until), handled_by=$5, issue_method='visionline_desk', card_reg_no=$6,
          vl_user_id=COALESCE($7, vl_user_id), issued_count=issued_count+1, updated_at=now(), issued_by=$5, issued_at=now(), history = history || $8::jsonb WHERE id=$1`,
        [r.id, label, k.user_group ?? b.userGroup, k.expires_at, op.id, k.reg_no, k.card_holder, hist(op.displayName, `Linked to the existing Visionline keycard ${k.reg_no}${k.user_group ? ` (${k.user_group})` : ''}`)]);
      if (label) await upsertRegister(pool, hotelId, label, { department: r.department, staffType: r.staff_type, holder: `${r.given_name} ${r.surname}`, vlUserId: k.card_holder, regNo: k.reg_no, status: 'in_use', requestId: r.id });
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.issued', targetType: 'keycard_request', targetId: r.id, details: { number: r.number, method: 'existing', label, regNo: k.reg_no } });
      return { status: 'ISSUED' };
    }
    if (b.vlUserId) {
      if (!(await one(pool, `SELECT 1 FROM vl_users WHERE hotel_id=$1 AND user_id=$2`, [hotelId, b.vlUserId]))) throw badRequest('UNKNOWN_PERSON', 'This person is not in the list read from Visionline.');
      await pool.query(`UPDATE keycard_requests SET vl_user_id=$2 WHERE id=$1`, [r.id, b.vlUserId]); r.vl_user_id = b.vlUserId;
    }
    await pool.query(`UPDATE keycard_requests SET card_label=$2, user_group=$3, valid_until=$4, handled_by=$5, issued_by=$5, issue_method=$6, updated_at=now() WHERE id=$1`, [r.id, label, b.userGroup, until, op.id, b.method]);
    if (b.method === 'visionline_desk') {
      const vlOp = b.vlOperator ?? await vlOperatorOf(hotelId, op.id);
      await pool.query(`UPDATE keycard_requests SET status='ISSUED', card_reg_no=COALESCE($2, card_reg_no), issued_count=issued_count+1, issued_at=now(), vl_operator=$4, history = history || $3::jsonb WHERE id=$1`,
        [r.id, b.regNo ?? null, hist(op.displayName, `Issued from Visionline${vlOp ? ` by operator ${vlOp}` : ''}${b.regNo ? `, card ${b.regNo}` : ''}`), vlOp]);
      const reg = b.regNo ?? r.card_reg_no;
      if (reg && vlOp) await pool.query(`INSERT INTO vl_card_issuers (hotel_id, reg_no, operator, issued_at, source, recorded_by) VALUES ($1,$2,$3,now(),'portal',$4)
        ON CONFLICT (hotel_id, reg_no) DO UPDATE SET operator=EXCLUDED.operator, issued_at=EXCLUDED.issued_at, source='portal', recorded_by=EXCLUDED.recorded_by, import_id=NULL`, [hotelId, reg, vlOp, op.id]);
      if (label) await upsertRegister(pool, hotelId, label, { department: r.department, staffType: r.staff_type, holder: `${r.given_name} ${r.surname}`, vlUserId: r.vl_user_id, regNo: b.regNo ?? null, status: 'in_use', requestId: r.id });
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.issued', targetType: 'keycard_request', targetId: r.id, details: { number: r.number, method: 'visionline_desk', label, regNo: b.regNo, vlOperator: vlOp } });
      return { status: 'ISSUED' };
    }
    if (!pol.encodeEnabled) throw conflict('ENCODE_OFF', 'Encoding from the portal is switched off (Settings -> Keycards). Make the card in Visionline and record it here (Issued from Visionline).');
    if (!b.encoder || (pol.encoders.length && !pol.encoders.includes(b.encoder))) throw badRequest('UNKNOWN_ENCODER', 'Choose one of the encoders chosen in Settings -> Keycards.');
    const ug = await one(pool, `SELECT data FROM resources WHERE hotel_id=$1 AND kind='usergroup' AND external_id=$2 AND active`, [hotelId, b.userGroup]);
    if (!ug) throw badRequest('UNKNOWN_GROUP', 'Unknown Visionline user group.');
    const groupDoors = (ug.data?.doorOperations ?? []).flatMap((o: any) => o.doors ?? []);
    const doors = b.doorIds.length ? b.doorIds : groupDoors;
    if (!ug.data?.uniformAccess && !doors.length) throw badRequest('NO_DOORS', 'Choose the doors (the user group has none).');
    const holder = holderId(r);
    const payload = { kind: 'staff', encoder: b.encoder, cardHolder: holder, user: { givenName: r.given_name, surname: r.surname, userGroup: b.userGroup },
      doorIds: ug.data?.uniformAccess ? [] : doors, onOffDoorIds: [], expireTime: until, override: b.replaceExisting || r.kind === 'replacement', overwriteValidCard: false,
      context: { requestId: r.id, step: 'issue' } };
    const cmd = await enqueue(pool, { hotelId, type: 'ENCODE_KEYCARD', payload, idempotencyKey: `kr-issue:${r.id}:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 180, requestedBy: op.id });
    await pool.query(`UPDATE keycard_requests SET command_id=$2, history = history || $3::jsonb WHERE id=$1`, [r.id, cmd.id, hist(op.displayName, `Sent to encoder ${b.encoder}: place a blank card on it`)]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.encode_requested', targetType: 'keycard_request', targetId: r.id, details: { number: r.number, encoder: b.encoder, label, userGroup: b.userGroup, until } });
    return { commandId: cmd.id };
  });

  /** Resignation / cancellation: record the return and stop the card in Visionline; HR and security are told. */
  app.post(`${base}/requests/:id/collect`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.manage');
    const r = await load(hotelId, (req.params as any).id);
    const b = z.object({ returnState: z.enum(['returned', 'lost', 'damaged', 'not_returned']), method: z.enum(['expire_now', 'cancel_card', 'visionline_desk']),
      encoder: z.string().regex(/^[\w .-]{1,40}$/).optional(), regNo: z.string().regex(/^\d{1,12}$/).optional().nullable() }).parse(req.body);
    if (['COLLECTED', 'REJECTED', 'WITHDRAWN'].includes(r.status)) throw conflict('CLOSED', 'This request is closed.');
    const regNo = b.regNo ?? r.card_reg_no;
    await pool.query(`UPDATE keycard_requests SET return_state=$2, cancel_method=$3, card_reg_no=COALESCE($4, card_reg_no), handled_by=$5, updated_at=now() WHERE id=$1`, [r.id, b.returnState, b.method, regNo, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.collected', targetType: 'keycard_request', targetId: r.id, details: { number: r.number, returnState: b.returnState, method: b.method, label: r.card_label, regNo } });
    if (b.method === 'visionline_desk') {
      await tx(async (c) => onKeycardCommandResult(c, { hotel_id: hotelId, type: 'CANCEL_KEYCARD', payload: { context: { requestId: r.id, step: 'collect' } } }, { status: 'SUCCEEDED' }));
      return { status: 'COLLECTED' };
    }
    const pol = await kcPolicy(hotelId);
    if (!pol.encodeEnabled && b.method === 'expire_now') throw conflict('ENCODE_OFF', 'Encoding from the portal is switched off. Cancel the card by its number instead, or in Visionline.');
    let cmd: any;
    if (b.method === 'expire_now') {
      if (!b.encoder) throw badRequest('UNKNOWN_ENCODER', 'Choose the encoder where the returned card lies.');
      cmd = await enqueue(pool, { hotelId, type: 'ENCODE_KEYCARD', payload: { kind: 'expireNow', encoder: b.encoder, cardHolder: holderId(r), doorIds: [(await one(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='door' AND active ORDER BY name LIMIT 1`, [hotelId]))?.external_id ?? '1'],
        onOffDoorIds: [], override: true, overwriteValidCard: true, context: { requestId: r.id, step: 'collect' } }, idempotencyKey: `kr-collect:${r.id}:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 180, requestedBy: op.id });
    } else {
      if (!regNo) throw badRequest('REG_NO_REQUIRED', 'Enter the Visionline card number to cancel (Card lookup shows it).');
      cmd = await enqueue(pool, { hotelId, type: 'CANCEL_KEYCARD', payload: { regNo, context: { requestId: r.id, step: 'collect' } }, idempotencyKey: `kr-cancel:${r.id}:${regNo}`, correlationId: newCorrelationId(), ttlSec: 180 });
    }
    await pool.query(`UPDATE keycard_requests SET command_id=$2, history = history || $3::jsonb WHERE id=$1`, [r.id, cmd.id, hist(op.displayName, b.method === 'expire_now' ? `Returned card sent to encoder ${b.encoder} (1-minute card)` : `Cancel card ${regNo} in Visionline`)]);
    return { commandId: cmd.id };
  });
  /** Send one request (or the whole register) to HR by e-mail. */
  app.post(`${base}/requests/:id/share`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.read');
    const r = await load(hotelId, (req.params as any).id);
    const pol = await kcPolicy(hotelId);
    const to = r.hr_email ?? pol.hrEmail;
    if (!to) throw badRequest('NO_HR_EMAIL', 'Add the HR e-mail (on the request or in Settings -> Keycards).');
    const ch = await channels(hotelId);
    if (!ch.email?.enabled) throw conflict('EMAIL_OFF', 'E-mail is not set up (Settings -> Alerts & notifications).');
    await sendEmail(ch.email, to, `Keycard request ${r.number} - ${r.given_name} ${r.surname}`,
      [`Request ${r.number} (${r.kind}, ${r.staff_type})`, `Name: ${r.given_name} ${r.surname}`, `Department: ${r.department}`, r.employee_no ? `Employee no: ${r.employee_no}` : '',
        `Card number: ${r.card_label ?? '-'}`, `Status: ${r.status}`, `Manager: ${r.manager_name}`, `Reason: ${r.reason}`, '', ...((r.history ?? []) as any[]).map((h) => `${h.at.slice(0, 16).replace('T', ' ')}  ${h.by}: ${h.what}`)].filter((x) => x !== null).join('\n'), hotelId);
    await pool.query(`UPDATE keycard_requests SET notified = notified || $2::jsonb WHERE id=$1`, [r.id, JSON.stringify([{ to, ok: true, at: new Date().toISOString(), by: op.displayName }])]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.shared', targetType: 'keycard_request', targetId: r.id, details: { to } });
    return { sentTo: to };
  });

  // ---- Register, reminders, holders with several cards, encoders -------------------------------------------------
  /** 2.17 Existing Visionline people and keycards, to issue from (no duplicate person, or link an existing card). */
  app.get(`${base}/visionline-search`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'keycards.manage');
    const q = z.string().trim().max(60).default('').parse((req.query as any).q ?? '');
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const people = await many(pool, `SELECT u.user_id, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS name, u.user_group,
        (SELECT count(*)::int FROM vl_cards k WHERE k.hotel_id=u.hotel_id AND k.card_holder=u.user_id AND k.active AND NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired) AND (k.expires_at IS NULL OR k.expires_at > now())) AS cards
      FROM vl_users u WHERE u.hotel_id=$1 AND u.active AND ($2 = '' OR u.user_id ILIKE $3 OR u.given_name ILIKE $3 OR u.surname ILIKE $3 OR (coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')) ILIKE $3)
      ORDER BY u.surname NULLS LAST, u.given_name LIMIT 20`, [hotelId, q, like]);
    const cards = await many(pool, `SELECT k.reg_no, k.card_holder, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS name, COALESCE(u.user_group, k.user_group) AS user_group,
        k.expires_at, (k.key_id IS NOT NULL OR k.mobile IS TRUE) AS mobile
      FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
      WHERE k.hotel_id=$1 AND k.active AND NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired) AND (k.expires_at IS NULL OR k.expires_at > now())
        AND ($2 = '' OR k.reg_no ILIKE $3 OR k.card_holder ILIKE $3 OR u.given_name ILIKE $3 OR u.surname ILIKE $3 OR (coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')) ILIKE $3)
      ORDER BY k.first_seen_at DESC LIMIT 20`, [hotelId, q, like]);
    return { people, cards };
  });

  app.get(`${base}/register`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'keycards.read');
    const rows = await many(pool, `SELECT g.*, c.expires_at, c.cancelled, COALESCE(vl_issuer_label(g.hotel_id, g.card_reg_no), ib.display_name || CASE WHEN q.issue_method='encoder' THEN ' (encoded from the portal)' WHEN q.issue_method='visionline_desk' THEN ' (recorded in the portal' || COALESCE(', Visionline operator ' || q.vl_operator, '') || ')' ELSE '' END) AS issued_by, q.issued_at FROM keycard_register g LEFT JOIN vl_cards c ON c.hotel_id=g.hotel_id AND c.reg_no=g.card_reg_no
      LEFT JOIN keycard_requests q ON q.id=g.request_id LEFT JOIN operators ib ON ib.id=q.issued_by WHERE g.hotel_id=$1 ORDER BY g.label`, [hotelId]);
    return rows.map((x) => ({ label: x.label, department: x.department, staffType: x.staff_type, holder: x.holder_name, vlUserId: x.vl_user_id, regNo: x.card_reg_no, status: x.status, expiresAt: x.expires_at, updatedAt: x.updated_at, issuedBy: x.issued_by ?? null, issuedAt: x.issued_at ?? null }));
  });
  app.get(`${base}/register.csv`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.read');
    const rows = await many(pool, `SELECT g.label, g.department, g.staff_type, g.holder_name, g.card_reg_no, g.status, g.updated_at, COALESCE(vl_issuer_label(g.hotel_id, g.card_reg_no), ib.display_name || CASE WHEN q.issue_method='encoder' THEN ' (encoded from the portal)' WHEN q.issue_method='visionline_desk' THEN ' (recorded in the portal' || COALESCE(', Visionline operator ' || q.vl_operator, '') || ')' ELSE '' END) AS issued_by, q.issued_at FROM keycard_register g LEFT JOIN keycard_requests q ON q.id=g.request_id LEFT JOIN operators ib ON ib.id=q.issued_by WHERE g.hotel_id=$1 ORDER BY g.label`, [hotelId]);
    const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.register_exported', details: { rows: rows.length } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="keycard-register.csv"');
    return '﻿' + ['Card,Department,Type,Holder,Visionline card,Status,Issued by,Issued,Updated', ...rows.map((r) => [r.label, r.department, r.staff_type, r.holder_name, r.card_reg_no, r.status, r.issued_by, r.issued_at?.toISOString?.(), r.updated_at?.toISOString?.()].map(cell).join(','))].join('\r\n');
  });
  /** Staff keycards that end soon (renewal reminders) and people holding more than one valid card. */
  app.get(`${base}/attention`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'keycards.read');
    const q = z.object({ days: z.coerce.number().int().min(1).max(120).default(30) }).parse(req.query);
    const [expiring, several, open] = await Promise.all([
      many(pool, `SELECT c.reg_no, c.card_holder, c.user_group, c.expires_at, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS name, g.label
          FROM vl_cards c LEFT JOIN vl_users u ON u.hotel_id=c.hotel_id AND u.user_id=c.card_holder LEFT JOIN keycard_register g ON g.hotel_id=c.hotel_id AND g.card_reg_no=c.reg_no
          WHERE c.hotel_id=$1 AND c.active AND NOT c.cancelled AND c.key_id IS NULL AND c.expires_at BETWEEN now() AND now() + make_interval(days => $2) ORDER BY c.expires_at LIMIT 300`, [hotelId, q.days]),
      many(pool, `SELECT c.card_holder, max(c.user_group) AS user_group, count(*)::int AS cards, array_agg(c.reg_no ORDER BY c.expires_at DESC) AS reg_nos,
            max(NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '')) AS name
          FROM vl_cards c LEFT JOIN vl_users u ON u.hotel_id=c.hotel_id AND u.user_id=c.card_holder
          WHERE c.hotel_id=$1 AND c.active AND NOT c.cancelled AND NOT c.expired AND c.key_id IS NULL AND c.card_holder IS NOT NULL AND (c.expires_at IS NULL OR c.expires_at > now())
          GROUP BY c.card_holder HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 200`, [hotelId]),
      one(pool, `SELECT count(*) FILTER (WHERE status='SUBMITTED')::int AS submitted FROM keycard_requests WHERE hotel_id=$1`, [hotelId]),
    ]);
    const generic = await genericCards(hotelId);
    return { expiring: expiring.map((x) => ({ regNo: x.reg_no, holder: x.card_holder, name: x.name ?? x.card_holder, group: x.user_group, expiresAt: x.expires_at, label: x.label })),
      several: several.map((x) => ({ holder: x.card_holder, name: x.name ?? x.card_holder, group: x.user_group, cards: x.cards, regNos: x.reg_nos })), submitted: open?.submitted ?? 0,
      generic };
  });
  /** Encoders known to Visionline (read with the doors) and the ones the hotel chose. */
  app.get(`${base}/encoders`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'keycards.read');
    const pol = await kcPolicy(hotelId);
    const known = await many(pool, `SELECT external_id, discovered_at FROM resources WHERE hotel_id=$1 AND kind='encoder' AND active ORDER BY external_id`, [hotelId]);
    const last = await many(pool, `SELECT DISTINCT ON (payload->>'encoder') payload->>'encoder' AS encoder, status, completed_at, error->>'message' AS error FROM commands
        WHERE hotel_id=$1 AND type IN ('ENCODE_KEYCARD','READ_CARD') AND payload ? 'encoder' ORDER BY payload->>'encoder', created_at DESC`, [hotelId]);
    const lastBy = new Map(last.map((l) => [l.encoder, l]));
    const names = [...new Set([...known.map((k) => k.external_id), ...pol.encoders])];
    return { encodeEnabled: pol.encodeEnabled, chosen: pol.encoders, encoders: names.map((n) => ({ name: n, inVisionline: known.some((k) => k.external_id === n), chosen: pol.encoders.includes(n),
      last: lastBy.get(n) ? { status: lastBy.get(n).status, at: lastBy.get(n).completed_at, error: lastBy.get(n).error } : null })) };
  });
  app.post(`${base}/encoders/refresh`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.manage');
    const cmd = await enqueue(pool, { hotelId, type: 'LIST_ENCODERS', payload: {}, idempotencyKey: `enc:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 120 });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.encoders_refresh_requested' });
    return { commandId: cmd.id };
  });

  /** Special cards at an encoder: emergency, stand open, clearance, one-time [Web API §7.22]. */
  app.post(`${base}/special`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'keycards.manage');
    const b = z.object({ kind: z.enum(['emergency', 'standOpen', 'clearance', 'oneTime']), encoder: z.string().regex(/^[\w .-]{1,40}$/), holder: z.string().trim().min(2).max(60),
      doorIds: z.array(z.string().max(100)).max(200).default([]), expireTime: z.string().datetime().optional() }).parse(req.body);
    const pol = await kcPolicy(hotelId);
    if (!pol.encodeEnabled) throw conflict('ENCODE_OFF', 'Encoding from the portal is switched off (Settings -> Keycards).');
    if (['standOpen', 'oneTime'].includes(b.kind) && !b.doorIds.length) throw badRequest('NO_DOORS', 'Choose the doors.');
    const cardHolder = `special-${b.kind.toLowerCase()}`;
    const cmd = await enqueue(pool, { hotelId, type: 'ENCODE_KEYCARD', payload: { kind: b.kind, encoder: b.encoder, cardHolder, user: { givenName: b.holder, surname: `(${b.kind})`, userGroup: (await one(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='usergroup' AND active ORDER BY external_id LIMIT 1`, [hotelId]))?.external_id ?? 'Staff' },
      doorIds: b.doorIds, onOffDoorIds: [], expireTime: b.expireTime ?? new Date(Date.now() + 86_400_000).toISOString(), override: false, overwriteValidCard: true },
      idempotencyKey: `special:${b.kind}:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 180, requestedBy: op.id });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.special_card_requested', details: { kind: b.kind, encoder: b.encoder, holder: b.holder, doors: b.doorIds.length } });
    return { commandId: cmd.id };
  });

  // ---- Departures: checkout reached the lock (online) or clearance card placed (offline) ---------------------------
  app.get(`${P}/hotels/:hotelId/departures`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'lockout.request');
    const tz = (await getConfig(pool, hotelId, 'property'))?.timezone ?? 'UTC';
    const day = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query).day ?? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const rows = await many(pool, `SELECT s.room, max(s.guest_name) AS guest, bool_or(s.checked_out_at IS NOT NULL) AS checked_out, max(d.status) AS status, max(d.done_at) AS done_at, max(o.display_name) AS done_by,
        max((r.data->>'online')) AS online
      FROM bf_stays s LEFT JOIN departure_checks d ON d.hotel_id=s.hotel_id AND d.day=$2::date AND d.room=s.room LEFT JOIN operators o ON o.id=d.done_by
      LEFT JOIN resources r ON r.hotel_id=s.hotel_id AND r.kind='door' AND (r.name=s.room OR r.external_id=s.room)
      WHERE s.hotel_id=$1 AND (s.departure=$2::date OR s.ended_on=$2::date OR s.checked_out_at::date=$2::date) GROUP BY s.room ORDER BY s.room`, [hotelId, day]);
    return { day, rooms: rows.map((r) => ({ room: r.room, guest: r.guest, checkedOut: r.checked_out, online: r.online === 'true', status: r.status ?? null, doneAt: r.done_at, doneBy: r.done_by })) };
  });
  /** Online rooms: send the checkout command [§7.13.2]; offline rooms: record that the clearance card was placed. */
  app.post(`${P}/hotels/:hotelId/departures`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'lockout.request');
    const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rooms: z.array(z.string().min(1).max(20)).min(1).max(300), action: z.enum(['checkout', 'cleared']) }).parse(req.body);
    const doors = await many(pool, `SELECT external_id, name, data FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND (name = ANY($2) OR external_id = ANY($2))`, [hotelId, b.rooms]);
    if (b.action === 'cleared') {
      for (const r of b.rooms) await pool.query(`INSERT INTO departure_checks (hotel_id, day, room, online, status, done_by, done_at) VALUES ($1,$2,$3,false,'CLEARED',$4,now())
          ON CONFLICT (hotel_id, day, room) DO UPDATE SET status='CLEARED', done_by=$4, done_at=now()`, [hotelId, b.day, r, op.id]);
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'departure.clearance_card_placed', details: { day: b.day, rooms: b.rooms } });
      return { cleared: b.rooms.length };
    }
    const online = doors.filter((d) => d.data?.online === true).map((d) => d.external_id);
    if (!online.length) throw badRequest('NO_ONLINE', 'None of these rooms has an online lock: place the clearance card and mark them as cleared.');
    const cmd = await enqueue(pool, { hotelId, type: 'DOOR_COMMANDS', payload: { command: 'checkout', doors: online.slice(0, 60), parallel: 4, timeoutSec: 30, context: { departureDay: b.day } }, idempotencyKey: `dep:${b.day}:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 300 });
    for (const r of online.slice(0, 60)) await pool.query(`INSERT INTO departure_checks (hotel_id, day, room, online, status, command_id, done_by, done_at) VALUES ($1,$2,$3,true,'SENT',$4,$5,now())
        ON CONFLICT (hotel_id, day, room) DO UPDATE SET status='SENT', command_id=$4, done_by=$5, done_at=now()`, [hotelId, b.day, r, cmd.id, op.id]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'departure.checkout_sent', details: { day: b.day, rooms: online.length } });
    return { commandId: cmd.id, sent: online.length };
  });

  // ---- System setup report (like the Visionline "System Setup Report") --------------------------------------------
  app.get(`${P}/hotels/:hotelId/reports/setup`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    // 2.27.1 Never a blank page: the report says which step is slow instead of waiting for ever, and the portal part
    // (no Visionline data) comes on its own.
    const part = (req.query as any)?.part === 'portal' ? 'portal' : 'all';
    const st = { step: 'reading the site settings' };
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<'slow'>((resolve) => { timer = setTimeout(() => resolve('slow'), SETUP_REPORT_LIMIT_MS); });
    const r = await Promise.race([buildSetupReport(hotelId, op, st, part), slow]).finally(() => clearTimeout(timer));
    if (r === 'slow') {
      const busy = await many(pool, `SELECT state, extract(epoch FROM now() - xact_start)::int AS s, left(regexp_replace(query, '\s+', ' ', 'g'), 90) AS q FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start < now() - interval '30 seconds' ORDER BY xact_start LIMIT 3`).catch(() => []);
      req.log.warn({ step: st.step, busy }, 'setup report too slow');
      throw new ApiError(503, 'SETUP_REPORT_SLOW', `The setup report took more than ${Math.round(SETUP_REPORT_LIMIT_MS / 1000)} seconds (still ${st.step}).${busy.length ? ` The database is busy with: ${busy.map((b) => `${b.state} for ${b.s} s (${b.q})`).join('; ')}.` : ''} Try again in a minute; if it repeats, restart the service StaffMobileKeyPlatform.`);
    }
    req.log.info({ ms: Date.now() - t0, part }, 'setup report');
    return r;
  });

  // ---- 2.14 "To do now" for the Overview: only what this person can act on ----------------------------------------
  app.get(`${P}/hotels/:hotelId/today`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    if (!op.isPlatformAdmin && !op.roles.has(hotelId)) throw forbidden('You are not a member of this site.');
    const pm = permsIn(op, hotelId);
    const items: { id: string; tone: 'bad' | 'warn' | 'info'; title: string; detail: string; to: string; n: number }[] = [];
    const em = pm.has('muster.read') ? await one(pool, `SELECT kind, status FROM emergencies WHERE hotel_id=$1 AND status IN ('REQUESTED','ACTIVE') LIMIT 1`, [hotelId]) : null;
    if (em) items.push({ id: 'emergency', tone: 'bad', title: em.status === 'ACTIVE' ? `${em.kind === 'drill' ? 'Drill' : 'Emergency'} in progress` : 'Emergency waiting for confirmation', detail: 'Roll call on Live occupancy', to: '/muster', n: 1 });
    if (pm.has('keycards.manage')) {
      const k = await one(pool, `SELECT count(*)::int AS n FROM keycard_requests WHERE hotel_id=$1 AND status='SUBMITTED'`, [hotelId]);
      if (k?.n) items.push({ id: 'requests', tone: 'warn', title: `${k.n} keycard request(s) to handle`, detail: 'Issue, reject or cancel', to: '/keycards', n: k.n });
      const e = await one(pool, `SELECT count(*)::int AS n FROM vl_cards WHERE hotel_id=$1 AND active AND NOT cancelled AND key_id IS NULL AND expires_at BETWEEN now() AND now() + interval '7 days'`, [hotelId]);
      if (e?.n) items.push({ id: 'renew', tone: 'warn', title: `${e.n} staff keycard(s) end within 7 days`, detail: 'Ask the managers to renew them', to: '/keycards?tab=attention', n: e.n });
    }
    if (pm.has('lockout.approve')) {
      const l = await one(pool, `SELECT count(*)::int AS n FROM guest_lockouts WHERE hotel_id=$1 AND status='REQUESTED' AND requested_by IS DISTINCT FROM $2`, [hotelId, op.id]);
      if (l?.n) items.push({ id: 'lockouts', tone: 'warn', title: `${l.n} unpaid-guest lock-out(s) to approve`, detail: 'Front office is waiting', to: '/keycards?tab=lockouts', n: l.n });
    }
    if (pm.has('lockout.request')) {
      const d = await one(pool, `SELECT count(DISTINCT s.room)::int AS n FROM bf_stays s WHERE s.hotel_id=$1 AND s.departure=current_date AND NOT EXISTS (SELECT 1 FROM departure_checks c WHERE c.hotel_id=s.hotel_id AND c.day=current_date AND c.room=s.room AND c.status IN ('REACHED','CLEARED'))`, [hotelId]);
      if (d?.n) items.push({ id: 'departures', tone: 'info', title: `${d.n} departure(s) to clear at the lock`, detail: 'Checkout to online locks, clearance card for offline ones', to: '/keycards?tab=departures', n: d.n });
    }
    if (pm.has('key.approve_broad')) {
      const a = await one(pool, `SELECT count(*)::int AS n FROM key_requests WHERE hotel_id=$1 AND status='PENDING_APPROVAL' AND requested_by IS DISTINCT FROM $2`, [hotelId, op.id]);
      if (a?.n) items.push({ id: 'approve', tone: 'warn', title: `${a.n} mobile key(s) waiting for approval`, detail: 'Broad access needs a second person', to: '/keys', n: a.n });
    }
    return { items, at: new Date().toISOString() };
  });

  // ---- Accounts daily report --------------------------------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/reports/accounts`, async (req) => {
    const hotelId = hid(req);
    await requirePerm(req, hotelId, 'reports.read');
    return buildAccountsReport(hotelId);
  });
  app.post(`${P}/hotels/:hotelId/reports/accounts/read-guest-cards`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const cmd = await requestGuestCardRead(hotelId);
    if (!cmd) throw badRequest('NO_ROOMS', 'No guest rooms read from Visionline yet.');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.guest_cards_read_requested' });
    return { commandId: cmd.id };
  });
  app.post(`${P}/hotels/:hotelId/reports/accounts/send`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'settings.manage');
    const emails = ((await getConfig(pool, hotelId, 'policy'))?.accountsReport?.emails ?? []) as string[];
    if (!emails.length) throw badRequest('NO_EMAILS', 'Add the Accounts e-mail addresses first (Settings -> Accounts report).');
    try { const r = await sendAccountsReport(hotelId, emails, op.id); return { sentTo: emails.length, rooms: r.rooms }; }
    catch (e) { throw conflict('EMAIL_FAILED', (e as Error).message); }
  });

  // ---- Unpaid guest: front office asks, a manager approves --------------------------------------------------------
  app.get(`${P}/hotels/:hotelId/lockouts`, async (req) => {
    const hotelId = hid(req);
    const op = await requireOperator(req);
    const perms = permsIn(op, hotelId);
    if (!perms.has('lockout.request') && !perms.has('lockout.approve')) throw forbidden();
    const rows = await many(pool, `SELECT l.*, a.display_name AS requested_name, b.display_name AS approved_name FROM guest_lockouts l LEFT JOIN operators a ON a.id=l.requested_by LEFT JOIN operators b ON b.id=l.approved_by
        WHERE l.hotel_id=$1 ORDER BY (l.status='REQUESTED') DESC, l.created_at DESC LIMIT 300`, [hotelId]);
    return rows.map((l) => ({ id: l.id, room: l.room, guestName: l.guest_name, amount: l.amount, reason: l.reason, status: l.status, method: l.method, doorOnline: l.door_online, note: l.note,
      requestedBy: l.requested_name, approvedBy: l.approved_name, history: l.history, createdAt: l.created_at, requestedById: l.requested_by }));
  });
  app.post(`${P}/hotels/:hotelId/lockouts`, async (req, reply) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'lockout.request');
    const b = z.object({ room: z.string().trim().min(1).max(20), guestName: z.string().trim().max(120).optional().nullable(), amount: z.string().trim().max(40).optional().nullable(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const door = await one(pool, `SELECT external_id, data FROM resources WHERE hotel_id=$1 AND kind='door' AND active AND (name=$2 OR external_id=$2) LIMIT 1`, [hotelId, b.room]);
    if (!door) throw badRequest('UNKNOWN_ROOM', `Room ${b.room} is not a door read from Visionline.`);
    const r = await one(pool, `INSERT INTO guest_lockouts (hotel_id, room, guest_name, amount, reason, status, door_online, requested_by, history) VALUES ($1,$2,$3,$4,$5,'REQUESTED',$6,$7,$8) RETURNING id`,
      [hotelId, door.external_id, b.guestName ?? null, b.amount ?? null, b.reason, door.data?.online ?? null, op.id, hist(op.displayName, 'Requested')]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lockout.requested', targetType: 'guest_lockout', targetId: r!.id, details: { room: door.external_id, guest: b.guestName, amount: b.amount, reason: b.reason } });
    return reply.code(201).send({ id: r!.id });
  });
  app.post(`${P}/hotels/:hotelId/lockouts/:id/decide`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'lockout.approve');
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional(), encoder: z.string().regex(/^[\w .-]{1,40}$/).optional() }).parse(req.body);
    const l = await one(pool, `SELECT * FROM guest_lockouts WHERE id=$1 AND hotel_id=$2`, [id, hotelId]);
    if (!l) throw notFound('Lock-out');
    if (l.status !== 'REQUESTED') throw conflict('NOT_OPEN', 'This lock-out was already decided.');
    if (l.requested_by === op.id) throw forbidden('A second person (a manager) must approve it.');
    if (!b.approve) {
      await pool.query(`UPDATE guest_lockouts SET status='REJECTED', approved_by=$3, note=$4, updated_at=now(), history = history || $5::jsonb WHERE id=$1 AND hotel_id=$2`, [id, hotelId, op.id, b.note ?? null, hist(op.displayName, `Rejected${b.note ? `: ${b.note}` : ''}`)]);
      await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lockout.rejected', targetType: 'guest_lockout', targetId: id });
      return { status: 'REJECTED' };
    }
    const door = await one(pool, `SELECT data FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id=$2`, [hotelId, l.room]);
    const online = Boolean(door?.data?.online);
    let cmd: any;
    if (online) {
      cmd = await enqueue(pool, { hotelId, type: 'DOOR_COMMANDS', payload: { command: 'checkout', doors: [l.room], parallel: 1, timeoutSec: 30, context: { lockoutId: id } }, idempotencyKey: `lockout:${id}`, correlationId: newCorrelationId(), ttlSec: 180 });
    } else {
      const pol = await kcPolicy(hotelId);
      if (!pol.encodeEnabled || !b.encoder) throw badRequest('ENCODER_REQUIRED', `Room ${l.room} has an offline lock: choose the encoder to make the 1-minute blocking card (Settings -> Keycards must allow encoding).`);
      cmd = await enqueue(pool, { hotelId, type: 'ENCODE_KEYCARD', payload: { kind: 'guestBlock', encoder: b.encoder, cardHolder: `blocked-${l.room}`, doorIds: [l.room], onOffDoorIds: [], override: true, overwriteValidCard: true, context: { lockoutId: id } },
        idempotencyKey: `lockout:${id}`, correlationId: newCorrelationId(), ttlSec: 180, requestedBy: op.id });
    }
    await pool.query(`UPDATE guest_lockouts SET status='APPROVED', approved_by=$3, method=$4, command_id=$5, door_online=$6, note=$7, updated_at=now(), history = history || $8::jsonb WHERE id=$1 AND hotel_id=$2`,
      [id, hotelId, op.id, online ? 'checkout_online' : 'card_offline', cmd.id, online, b.note ?? null, hist(op.displayName, online ? 'Approved: checkout command sent to the online lock' : `Approved: blocking card sent to encoder ${b.encoder}`)]);
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lockout.approved', targetType: 'guest_lockout', targetId: id, details: { room: l.room, online } });
    return { status: 'APPROVED', commandId: cmd.id, online };
  });
  app.post(`${P}/hotels/:hotelId/lockouts/:id/restore`, async (req) => {
    const hotelId = hid(req);
    const op = await requirePerm(req, hotelId, 'lockout.request');
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    const r = await one(pool, `UPDATE guest_lockouts SET status='RESTORED', updated_at=now(), history = history || $3::jsonb WHERE id=$1 AND hotel_id=$2 AND status IN ('DONE','APPROVED','FAILED') RETURNING id`, [id, hotelId, hist(op.displayName, `Settled, new key from front office: ${b.note}`)]);
    if (!r) throw conflict('NOT_DONE', 'Only a done lock-out can be closed as settled.');
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'lockout.restored', targetType: 'guest_lockout', targetId: id, details: { note: b.note } });
    return { status: 'RESTORED' };
  });
}

/** The System setup report (Visionline and portal). `part: 'portal'` skips the per-person and per-room work. */
async function buildSetupReport(hotelId: string, op: { id: string; displayName: string }, st: { step: string }, part: 'portal' | 'all') {
  const portalOnly = part === 'portal';
  const [prop, cs, pol, res, ops, h, conn, lic] = await Promise.all([
    getConfig(pool, hotelId, 'property'), getConfig(pool, hotelId, 'credential_services'), getConfig(pool, hotelId, 'policy'),
    many(pool, `SELECT kind, external_id, name, data FROM resources WHERE hotel_id=$1 AND active ORDER BY kind, name`, [hotelId]),
    many(pool, `SELECT o.display_name, o.email, o.mfa_enabled, o.last_sign_in_at, array_agg(m.role ORDER BY m.role) AS roles FROM operators o JOIN memberships m ON m.operator_id=o.id WHERE m.hotel_id=$1 GROUP BY o.id ORDER BY o.display_name`, [hotelId]),
    one(pool, `SELECT name, timezone FROM hotels WHERE id=$1`, [hotelId]),
    one(pool, `SELECT name, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]),
    one(pool, `SELECT payload FROM hotel_licences WHERE hotel_id=$1`, [hotelId]),
  ]);
  st.step = 'counting doors, keycards and people';
  const doors = res.filter((r) => r.kind === 'door');
  const groups = new Map<string, string[]>();
  for (const d of doors) { const g = d.data?.doorGroup ?? '(no group)'; groups.set(g, [...(groups.get(g) ?? []), d.name]); }
  const vlUsers = await one(pool, `SELECT count(*)::int AS n FROM vl_users WHERE hotel_id=$1 AND active`, [hotelId]);
  const vlCards = await one(pool, `SELECT count(*)::int AS n FROM vl_cards WHERE hotel_id=$1 AND active AND NOT cancelled`, [hotelId]);
  // Valid keycards that may override the deadbolt / privacy, per user group (from the cards themselves).
  const overrideCounts = new Map((await many(pool, `SELECT user_group, count(*)::int AS n FROM vl_cards WHERE hotel_id=$1 AND active AND NOT cancelled AND deadbolt_override GROUP BY 1`, [hotelId])).map((r) => [r.user_group, r.n]));
  // 2.17 Who has access to what: per user group (doors, door groups, people, keycards) and per person.
  const VALIDK = `k.active AND NOT (k.cancelled OR k.discarded OR k.overridden OR k.expired) AND (k.expires_at IS NULL OR k.expires_at > now())`;
  st.step = 'working out access per user group';
  const perGroup = portalOnly ? [] : await many(pool, `SELECT COALESCE(u.user_group, k.user_group) AS g, count(DISTINCT k.card_holder)::int AS people, count(*)::int AS cards,
      count(*) FILTER (WHERE k.deadbolt_override)::int AS override, count(*) FILTER (WHERE k.key_id IS NOT NULL OR k.mobile IS TRUE)::int AS mobile
    FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder WHERE k.hotel_id=$1 AND ${VALIDK} GROUP BY 1`, [hotelId]);
  st.step = 'working out access per person';
  const people = portalOnly ? [] : await many(pool, `SELECT k.card_holder, NULLIF(trim(coalesce(u.given_name,'') || ' ' || coalesce(u.surname,'')), '') AS name, COALESCE(u.user_group, k.user_group) AS g,
      count(*)::int AS cards, max(k.expires_at) AS until, bool_or(k.deadbolt_override) AS override, bool_or(k.key_id IS NOT NULL OR k.mobile IS TRUE) AS mobile,
      (SELECT array_agg(DISTINCT x) FROM vl_cards k2, unnest(k2.doors) x WHERE k2.hotel_id=$1 AND k2.card_holder=k.card_holder AND ${VALIDK.replace(/k\./g, 'k2.')}) AS doors,
      (SELECT array_agg(DISTINCT x) FROM vl_cards k2, unnest(k2.door_groups) x WHERE k2.hotel_id=$1 AND k2.card_holder=k.card_holder AND ${VALIDK.replace(/k\./g, 'k2.')}) AS door_groups,
      (SELECT o.display_name FROM operator_vl_links l JOIN operators o ON o.id=l.operator_id WHERE l.hotel_id=$1 AND l.vl_user_id=k.card_holder LIMIT 1) AS portal_user
    FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder WHERE k.hotel_id=$1 AND ${VALIDK} AND k.card_holder IS NOT NULL
    GROUP BY k.card_holder, u.given_name, u.surname, u.user_group, k.user_group ORDER BY 3 NULLS LAST, 2 NULLS LAST LIMIT 2000`, [hotelId]);
  st.step = 'reading the imported Visionline reports';
  const imported = await importedForSetupReport(hotelId);
  const vlOperator = conn?.health?.propertyUsername ?? null;
  // ---- 2.20 User groups vs. rooms: every room, which user groups open it (directly or through a door group) and how
  // many people hold a valid keycard for it; then the points worth a look.
  const ugs = res.filter((r) => r.kind === 'usergroup');
  const opens = new Map<string, { doors: Set<string>; doorGroups: Set<string> }>();
  for (const g of ugs) {
    const ops2 = (g.data?.doorOperations ?? []) as any[];
    opens.set(g.name, { doors: new Set(ops2.flatMap((o) => o.doors ?? [])), doorGroups: new Set(ops2.flatMap((o) => o.doorGroups ?? [])) });
  }
  st.step = 'matching rooms with user groups';
  const validCards = portalOnly ? [] : await many(pool, `SELECT k.card_holder, COALESCE(u.user_group, k.user_group) AS g, k.doors, k.door_groups FROM vl_cards k LEFT JOIN vl_users u ON u.hotel_id=k.hotel_id AND u.user_id=k.card_holder
    WHERE k.hotel_id=$1 AND ${VALIDK} AND k.key_id IS NULL AND NOT COALESCE(k.mobile, false) LIMIT 20000`, [hotelId]);
  // Who can open each door: indexed once (a large site has thousands of keycards and hundreds of doors).
  const byDoor = new Map<string, Set<string>>(); const byGroup = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, who: string) => { let v = m.get(k); if (!v) { v = new Set(); m.set(k, v); } v.add(who); };
  for (const k of validCards) { const who = k.card_holder ?? '?'; for (const d of k.doors ?? []) add(byDoor, d, who); for (const g of k.door_groups ?? []) add(byGroup, g, who); }
  const holdersOf = (doorName: string, doorId: string, dg: string | null) => new Set([...(byDoor.get(doorName) ?? []), ...(byDoor.get(doorId) ?? []), ...(dg != null ? byGroup.get(dg) ?? [] : [])]).size;
  const groupNames = ugs.map((g) => g.name).sort((a, b) => a.localeCompare(b));
  const rooms = doors.map((d) => {
    const dg = d.data?.doorGroup ?? null;
    const access = groupNames.map((gn) => { const o = opens.get(gn)!; return o.doors.has(d.name) || o.doors.has(d.external_id) ? 'D' : dg != null && o.doorGroups.has(dg) ? 'G' : ''; });
    return { name: d.name, group: dg, category: d.data?.doorCategory ?? null, online: d.data?.online ?? null, access, groups: access.filter(Boolean).length, people: holdersOf(d.name, d.external_id, dg) };
  }).sort((a, b) => (a.group ?? '~').localeCompare(b.group ?? '~') || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const insights: { level: 'warn' | 'info'; text: string }[] = [];
  const noGroup = rooms.filter((r) => !r.groups);
  if (noGroup.length) insights.push({ level: 'info', text: `${noGroup.length} of ${rooms.length} rooms are opened by no user group (only guest, master or special cards): ${noGroup.slice(0, 12).map((r) => r.name).join(', ')}${noGroup.length > 12 ? '…' : ''}.` });
  const all = groupNames.filter((gn, i) => rooms.length > 0 && rooms.every((r) => r.access[i]));
  if (all.length) insights.push({ level: 'warn', text: `Opening every room (master level): ${all.map((gn) => `${gn} (${perGroup.find((x) => x.g === gn)?.people ?? 0} people)`).join(', ')}. Check that only the right people hold these cards.` });
  const ov = ugs.filter((g) => g.data?.ignoreDeadbolt);
  if (ov.length) insights.push({ level: 'warn', text: `Override the deadbolt (open a room locked from inside): ${ov.map((g) => `${g.name} (${perGroup.find((x) => x.g === g.name)?.people ?? 0} people)`).join(', ')}.` });
  const guestRooms = rooms.filter((r) => /guest/i.test(r.category ?? ''));
  if (guestRooms.length) {
    const into = groupNames.map((gn, i) => ({ gn, n: guestRooms.filter((r) => r.access[i]).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    if (into.length) insights.push({ level: 'info', text: `Guest rooms opened by staff user groups: ${into.slice(0, 8).map((x) => `${x.gn} ${x.n}/${guestRooms.length}`).join(', ')}.` });
  }
  const busiest = [...rooms].sort((a, b) => b.people - a.people).filter((r) => r.people > 0).slice(0, 5);
  if (busiest.length) insights.push({ level: 'info', text: `Rooms most people can open: ${busiest.map((r) => `${r.name} (${r.people})`).join(', ')}.` });
  const unused = groupNames.filter((gn) => !(perGroup.find((x) => x.g === gn)?.cards));
  if (unused.length && validCards.length) insights.push({ level: 'info', text: `User groups with no valid keycard: ${unused.slice(0, 10).join(', ')}${unused.length > 10 ? '…' : ''}.` });
  st.step = 'looking for keycards in generic names';
  const gen = portalOnly ? [] : await genericCards(hotelId);
  if (gen.length) insights.push({ level: 'warn', text: `${gen.length} valid staff keycard(s) in a generic name (not a person): ${[...new Set(gen.map((x) => x.name || '(no name)'))].slice(0, 6).join(', ')}. Nobody can tell who used them.` });
  const portalInsights: { level: 'warn' | 'info'; text: string }[] = [];
  if (sharedVisionlineOperator(vlOperator)) portalInsights.push({ level: 'warn', text: `The portal works in Visionline as "${vlOperator}", a shared operator: give it a named operator.` });
  if (!imported.systemSettings) insights.push({ level: 'info', text: 'Import the Visionline System settings report (above) to show the Visionline version, AES and the system parameters.' });
  // 2.27 First page of the Visionline report: the facts, plainly.
  const g = imported.systemSettings ? visionlineGlance(imported.systemSettings as any) : null;
  // Keycards made through the PMS interface (shared PMS / interface operator), from the imported card list.
  const issuers = await many(pool, `SELECT operator, count(*)::int AS n, max(issued_at) AS last FROM vl_card_issuers WHERE hotel_id=$1 GROUP BY operator`, [hotelId]);
  const pmsIss = issuers.filter((r) => sharedVisionlineOperator(r.operator));
  const pmsActivity = issuers.length ? { operators: pmsIss.map((r) => r.operator as string), cards: pmsIss.reduce((n, r) => n + r.n, 0), last: pmsIss.map((r) => r.last).filter(Boolean).sort().pop() ?? null,
    fromCardLog: imported.cardLog ? { file: imported.cardLog.file, importedAt: imported.cardLog.importedAt } : null } : null;
  const count = (f: (d: any) => string | null) => { const m = new Map<string, { n: number; online: number }>(); for (const d of doors) { const k = f(d) ?? '(none)'; const c = m.get(k) ?? { n: 0, online: 0 }; c.n++; if (d.data?.online === true) c.online++; m.set(k, c); } return [...m.entries()].map(([name, c]) => ({ name, ...c })).sort((x, y) => y.n - x.n); };
  const onlineKnown = doors.filter((d) => typeof d.data?.online === 'boolean').length;
  const glance = {
    version: g?.version ?? null, versionFrom: g?.versionFrom ?? null, webApiVersion: conn?.health?.visionlineApiVersion ?? null,
    aes: g ? g.aes : { enabled: null, evidence: null }, encryption: g?.encryption ?? null, pmsEncryptionKey: g?.pmsEncryptionKey ?? null,
    keyMode: g?.keyMode ?? null, knownAuth: g?.knownAuth ?? [], clients: g?.clients ?? null, ev1: g?.ev1 ?? null, pms: g?.pms ?? [], pmsOptions: g?.pmsOptions ?? [], mobileLicence: g?.mobileLicence ?? null,
    pmsActivity,
    systemCode: g?.systemCode ?? null, systemId: g?.systemId ?? cs?.systemId ?? null, firmwarePack: g?.firmwarePack ?? null,
    locks: { total: doors.length, online: doors.filter((d) => d.data?.online === true).length, offline: doors.filter((d) => d.data?.online === false).length, onlineKnown,
      byCategory: count((d) => d.data?.doorCategory ?? null), byDoorGroup: count((d) => d.data?.doorGroup ?? null), inReport: g?.locksInReport ?? [] },
    userGroups: ugs.length, doorGroups: groups.size, timeSchedules: res.filter((r) => r.kind === 'timeschedule').length, encoders: res.filter((r) => r.kind === 'encoder').map((r) => r.name),
    people: vlUsers?.n ?? 0, validKeycards: vlCards?.n ?? 0, operators: imported.operators?.rows?.length ?? null,
    options: g?.options ?? [], mobileAccess: g?.mobileAccess ?? null, guestCards: g?.guestCards ?? [], eventsOn: g?.eventsOn ?? 0, eventsTotal: g?.eventsTotal ?? 0,
    source: imported.systemSettings ? { file: imported.systemSettings.file, importedAt: imported.systemSettings.importedAt } : null,
  };
  // Recorded without making the report wait (a busy audit trail must not leave the page blank).
  void audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'report.setup_viewed', details: { part } }).catch(() => undefined);
  st.step = 'putting the report together';
  return {
    printedAt: new Date().toISOString(), printedBy: op.displayName,
    property: { name: prop?.displayName ?? h?.name, systemId: cs?.systemId ?? null, timezone: prop?.timezone ?? h?.timezone, version: (await import('../version.ts')).PLATFORM_VERSION,
      locks: doors.length, locksOnline: doors.filter((d) => d.data?.online === true).length, userGroups: res.filter((r) => r.kind === 'usergroup').length, doorGroups: groups.size,
      timeSchedules: res.filter((r) => r.kind === 'timeschedule').length, encoders: res.filter((r) => r.kind === 'encoder').map((r) => r.name), visionlineUsers: vlUsers?.n ?? 0, validKeycards: vlCards?.n ?? 0,
      connector: conn ? { name: conn.name, lastSeen: conn.last_seen_at, version: conn.health?.connectorVersion ?? null, visionlineApi: conn.health?.visionlineApiVersion ?? null } : null,
      licence: lic?.payload ? { id: lic.payload.id, expires: lic.payload.expires ?? null, modules: lic.payload.modules } : null },
    userGroups: res.filter((r) => r.kind === 'usergroup').map((g) => ({ name: g.name, uniformAccess: Boolean(g.data?.uniformAccess), timeSchedule: g.data?.timeSchedule ?? null,
      // 2.16.1 Override rights [Web API §5.29.2]; null = not read yet (connector older than 0.13.1) or not reported.
      overrideDeadbolt: g.data?.ignoreDeadbolt ?? null, overridePrivacy: g.data?.ignorePrivacy ?? null,
      cardsWithOverride: overrideCounts.get(g.name) ?? 0,
      doors: (g.data?.doorOperations ?? []).flatMap((o: any) => [...(o.doors ?? []), ...(o.doorGroups ?? []).map((x: string) => `[${x}]`)]) })),
    doorGroups: [...groups.entries()].map(([g, ds]) => ({ name: g, doors: ds })),
    locks: doors.map((d) => ({ name: d.name, group: d.data?.doorGroup ?? null, category: d.data?.doorCategory ?? null, online: d.data?.online ?? null })),
    timeSchedules: res.filter((r) => r.kind === 'timeschedule').map((t) => t.name),
    keycardTypes: [['Staff keycard', 'Encoded at an encoder from the portal or issued from Visionline; one per person (override cancels older cards)'], ['Daily staff keycard', `Valid ${pol?.keycards?.dailyHours ?? 14} hours`],
      ['Emergency card', 'All doors, also with the deadbolt on; always valid until cancelled'], ['Stand-open card', 'Keeps chosen doors open'], ['Clearance card', 'Clears guest access from a lock'],
      ['One-time card', 'Opens chosen doors once'], ['Blocking card (unpaid guest)', 'Guest card for one room, override, expires after a minute'], ['Staff mobile key', 'On the staff app; issued through Visionline']],
    access: ops.map((o) => ({ name: o.display_name, email: o.email, roles: (o.roles as string[]).map((r) => (ROLE_LABELS as Record<string, string>)[r] ?? r), mfa: o.mfa_enabled, lastSignIn: o.last_sign_in_at })),
    accessByGroup: res.filter((r) => r.kind === 'usergroup').map((g) => {
      const ops2 = (g.data?.doorOperations ?? []) as any[];
      const st = perGroup.find((x) => x.g === g.name);
      return { name: g.name, uniformAccess: Boolean(g.data?.uniformAccess), doors: [...new Set(ops2.flatMap((o) => o.doors ?? []))], doorGroups: [...new Set(ops2.flatMap((o) => o.doorGroups ?? []))],
        overrideDeadbolt: g.data?.ignoreDeadbolt ?? null, people: st?.people ?? 0, cards: st?.cards ?? 0, cardsWithOverride: st?.override ?? 0, mobileKeys: st?.mobile ?? 0, timeSchedule: g.data?.timeSchedule ?? null };
    }),
    accessByPerson: people.map((p) => ({ id: p.card_holder, name: p.name, group: p.g, cards: p.cards, until: p.until, override: Boolean(p.override), mobile: Boolean(p.mobile),
      doors: (p.doors ?? []).slice(0, 400), doorGroups: p.door_groups ?? [], portalUser: p.portal_user ?? null })),
    visionline: { operatorUsed: vlOperator, operatorShared: sharedVisionlineOperator(vlOperator), ...imported },
    roomMatrix: { groups: groupNames, rooms }, insights, portalInsights, glance,
    parameters: [
      ['Key policy', `Longest key ${pol?.maxValidityHours ?? '-'} h; broad access from ${pol?.broadDoorThreshold ?? '-'} doors needs approval: ${pol?.requireApprovalForBroad === false ? 'no' : 'yes'}; wrong-door limit ${pol?.wrongDoorLimit ?? '-'}`],
      ['Keycard requests', `Encoding from the portal: ${pol?.keycards?.encodeEnabled ? 'on' : 'off'}; encoders: ${(pol?.keycards?.encoders ?? []).join(', ') || '-'}; HR e-mail: ${pol?.keycards?.hrEmail ? 'set' : 'not set'}`],
      ['Emergency', `Remote door commands: ${pol?.safety?.doorCommands?.enabled ? 'on' : 'off'}; back to normal at the end: ${pol?.safety?.doorCommands?.closeOnEnd === false ? 'no' : 'yes'}; emergency key template: ${pol?.safety?.emergencyTemplateId ? 'set' : 'not set'}`],
      ['Live occupancy', `Staff on site ${pol?.safety?.staffOnSiteHours ?? 10} h after their last door; rooms used ${pol?.safety?.roomActivityHours ?? 12} h`],
      ['Accounts report', pol?.accountsReport?.enabled ? `Daily at ${pol.accountsReport.time} to ${pol.accountsReport.emails.length} address(es)` : 'off'],
      ['Administrator protection', `Two-step sign-in required for administrators: ${pol?.adminSecurity?.requireAdminMfa ? 'yes' : 'no'}`],
      ['Privacy', `Lock events ${pol?.privacy?.lockEventsDays ?? 730} days; guest lists ${pol?.privacy?.guestListDays ?? 400} days; usage ${pol?.privacy?.usageDays ?? 730} days`],
    ],
  };
}
