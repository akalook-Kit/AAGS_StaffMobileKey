import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { genericCardName } from '@smk/shared';
import { fromVisionlineLocal } from '@smk/shared/node';
import { pool, many, one } from './db.ts';
import { audit } from './audit.ts';
import { permsIn, requireOperator } from './auth.ts';
import { ApiError, badRequest, conflict, forbidden, notFound } from './lib/errors.ts';
import { getConfig } from './hotel-config.ts';
import { enqueue, newCorrelationId } from './commands.ts';
import { isOnline } from './routes/portal.ts';
import { requestDirectorySync } from './directory.ts';

/**
 * 2.23 Verify a keycard at an encoder and extend it (Armel, 2 Nov: "verify with encoder and ... add a new date of expiry
 * on staff keycard ... whenever it is brought back and extend it should they require to").
 *
 *  1. The card is placed on an encoder and read: Visionline itself says whose card it is, its doors, door groups,
 *     validity (live, not the portal's stored lists).
 *  2. Extend: the same card is written again with the same holder, the same door operations (doors, door groups,
 *     operation) and the same time schedule, with the new expiry date. A card that had ended or was cancelled works
 *     again ("unlock"), only when confirmed. Visionline keeps one staff card per person, so the holder's other staff
 *     cards stop working (override), which the portal says before.
 * The card data used for the extension is the encoder read kept on the server (never sent back by the browser).
 */
const P = '/api/v1';
const hid = (req: FastifyRequest) => {
  const id = (req.params as any).hotelId as string;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Site');
  return id;
};
const Encoder = z.string().regex(/^[\w .-]{1,40}$/);

async function policy(hotelId: string) {
  const p = (await getConfig(pool, hotelId, 'policy'))?.keycards ?? {};
  const vl = await getConfig(pool, hotelId, 'visionline');
  return { encodeEnabled: Boolean(p.encodeEnabled), encoders: (p.encoders ?? []) as string[], readAction: (vl?.encoderRead?.action ?? 'read') as 'read' | 'readCard', readEncoders: (vl?.encoderRead?.encoders ?? []) as string[] };
}
async function who(req: FastifyRequest, hotelId: string) {
  const op = await requireOperator(req);
  const perms = permsIn(op, hotelId);
  if (!perms.has('keycards.read') && !perms.has('keycards.manage')) throw forbidden('Missing permission: keycards.read');
  return { op, manage: perms.has('keycards.manage') };
}
async function connectorWith(hotelId: string, cap: string) {
  const c = await one(pool, `SELECT id, last_seen_at, health FROM connectors WHERE hotel_id=$1 AND status='ACTIVE' ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [hotelId]);
  return { online: Boolean(c && isOnline(c.last_seen_at)), has: Boolean(c?.health?.capabilities?.includes?.(cap)) };
}
const validNow = (r: any) => !r.cancelled && !r.expired && !r.overridden;

/** A time from Visionline (local "YYYYMMDDTHHmm" in the site's time zone, or ISO) as a date. */
function readExpiry(s: string | null | undefined, tz: string): Date | null {
  if (!s) return null;
  try { return fromVisionlineLocal(s, tz); } catch { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
}

export function keycardCheckRoutes(app: FastifyInstance) {
  const base = `${P}/hotels/:hotelId/keycards/check`;

  /** Read the card lying on an encoder (live from Visionline). */
  app.post(`${base}/read`, async (req) => {
    const hotelId = hid(req);
    const { op } = await who(req, hotelId);
    const b = z.object({ encoder: Encoder }).parse(req.body);
    const pol = await policy(hotelId);
    const known = new Set([...pol.encoders, ...pol.readEncoders, ...(await many(pool, `SELECT external_id FROM resources WHERE hotel_id=$1 AND kind='encoder' AND active`, [hotelId])).map((r) => r.external_id as string)]);
    if (!known.has(b.encoder)) throw badRequest('UNKNOWN_ENCODER', 'Choose one of the encoders (Staff keycards → Encoders & special cards).');
    const c = await connectorWith(hotelId, 'encoder-read');
    if (!c.has) throw new ApiError(409, 'CONNECTOR_CAPABILITY', 'Reading a card at an encoder needs connector 0.10.0 or newer.');
    if (!c.online) throw new ApiError(409, 'CONNECTOR_OFFLINE', 'The connector is offline.');
    const recent = await one(pool, `SELECT count(*) FILTER (WHERE created_at > now() - interval '3 seconds')::int AS s3, count(*)::int AS m1 FROM commands WHERE hotel_id=$1 AND type='READ_CARD' AND created_at > now() - interval '1 minute'`, [hotelId]);
    if (recent!.s3 > 0 || recent!.m1 >= 20) throw new ApiError(429, 'TOO_FAST', 'A card was just read. Wait a few seconds before reading the next one.');
    const corr = `smk-${randomUUID()}`;
    const cmd = await enqueue(pool, { hotelId, type: 'READ_CARD', payload: { encoder: b.encoder, action: pol.readAction }, idempotencyKey: `kc-check:${randomUUID()}`, correlationId: corr, ttlSec: 60, requestedBy: op.id });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: 'keycard.check_read_requested', targetType: 'command', targetId: cmd.id, correlationId: corr, details: { encoder: b.encoder } });
    return { readId: cmd.id };
  });

  /** The card read: Visionline's answer, plus what the portal knows (holder, register number, request, issuer). */
  app.get(`${base}/:readId`, async (req) => {
    const hotelId = hid(req);
    const { manage } = await who(req, hotelId);
    const id = z.string().uuid().parse((req.params as any).readId);
    const c = await one(pool, `SELECT status, result, error, payload, completed_at FROM commands WHERE id=$1 AND hotel_id=$2 AND type='READ_CARD'`, [id, hotelId]);
    if (!c) throw notFound('Card read');
    if (c.status !== 'SUCCEEDED') return { status: c.status, error: c.error?.message ?? null };
    const r = c.result ?? {};
    const tz = (await getConfig(pool, hotelId, 'property'))?.timezone ?? process.env.HOTEL_TIMEZONE ?? 'UTC';
    const exp = readExpiry(r.expireTime, tz);
    const valid = validNow(r) && (!exp || exp.getTime() > Date.now());
    const u = r.cardHolder ? await one(pool, `SELECT given_name, surname, user_group FROM vl_users WHERE hotel_id=$1 AND user_id=$2`, [hotelId, r.cardHolder]) : null;
    const name = u ? [u.given_name, u.surname].filter(Boolean).join(' ') : null;
    const reg = r.regNo ? String(r.regNo) : null;
    const register = reg ? await one(pool, `SELECT label, status, holder_name FROM keycard_register WHERE hotel_id=$1 AND card_reg_no=$2`, [hotelId, reg]) : null;
    const request = await one(pool, `SELECT id, number, status, given_name, surname FROM keycard_requests WHERE hotel_id=$1 AND ((card_reg_no=$2 AND $2 IS NOT NULL) OR (vl_user_id=$3 AND $3 IS NOT NULL)) AND kind <> 'cancel' ORDER BY updated_at DESC LIMIT 1`, [hotelId, reg, r.cardHolder ?? null]);
    const issuer = reg ? await one(pool, `SELECT COALESCE((SELECT operator_name FROM portal_encoded_cards WHERE hotel_id=$1 AND reg_no=$2), vl_issuer_label($1, $2)) AS label`, [hotelId, reg]) : null;
    const others = r.cardHolder ? await one(pool, `SELECT count(*)::int AS n FROM vl_cards WHERE hotel_id=$1 AND card_holder=$2 AND reg_no <> COALESCE($3,'') AND active AND key_id IS NULL AND NOT COALESCE(mobile,false)
        AND NOT (cancelled OR discarded OR overridden OR expired) AND (expires_at IS NULL OR expires_at > now())`, [hotelId, r.cardHolder, reg]) : { n: 0 };
    const pol = await policy(hotelId);
    const conn = await connectorWith(hotelId, 'encode-operations');
    const ops = (r.operations ?? []) as { operation: string; doors: string[]; doorGroups: string[] }[];
    const simple = ops.length ? ops.every((o) => o.operation === 'normal' && !o.doorGroups?.length) : !(r.doorGroups ?? []).length;
    const doorNames = r.doors?.length ? await many(pool, `SELECT external_id, name FROM resources WHERE hotel_id=$1 AND kind='door' AND external_id = ANY($2::text[])`, [hotelId, r.doors]) : [];
    const dn = new Map(doorNames.map((d) => [d.external_id as string, d.name as string]));
    const blockers: string[] = [];
    if (!reg) blockers.push('Visionline gave no card number for this card.');
    if (r.mobile) blockers.push('This is a mobile key (a phone), not a keycard.');
    if (!r.cardHolder) blockers.push('Visionline gave no card holder: this is not a staff keycard (guest or special card).');
    if (!pol.encodeEnabled) blockers.push('Encoding from the portal is switched off (Settings → Keycards & encoders): extend it in Visionline.');
    if (!manage) blockers.push('Extending a keycard needs the right to issue keycards.');
    if (!simple && !conn.has) blockers.push('This card has door groups or special door operations: extending it from the portal needs connector 0.16.0 (in the 2.23 installer).');
    if (!(r.doors?.length || r.doorGroups?.length)) blockers.push('Visionline gave no doors for this card.');
    return {
      status: 'SUCCEEDED', readAt: c.completed_at, encoder: c.payload?.encoder,
      card: { regNo: reg, holderId: r.cardHolder ?? null, holder: name, group: u?.user_group ?? null, genericName: Boolean(r.cardHolder) && genericCardName(name ?? r.cardHolder),
        valid, cancelled: Boolean(r.cancelled), overridden: Boolean(r.overridden), expired: Boolean(r.expired) || Boolean(exp && exp.getTime() <= Date.now()),
        startsAt: readExpiry(r.startTime, tz), expiresAt: exp, doors: (r.doors ?? []).map((d: string) => dn.get(d) ?? d), doorGroups: r.doorGroups ?? [], timeSchedule: r.timeSchedule ?? null, mobile: Boolean(r.mobile),
        label: register?.label ?? null, registerStatus: register?.status ?? null, request: request ? { id: request.id, number: request.number, status: request.status } : null,
        issuedBy: issuer?.label ?? (reg ? 'Issued from Visionline' : null), otherValidCards: others?.n ?? 0 },
      extend: { possible: blockers.length === 0, blockers, encoders: pol.encoders },
    };
  });

  /** Write the same card again with a new expiry date (the card must still lie on the encoder). */
  app.post(`${base}/:readId/extend`, async (req) => {
    const hotelId = hid(req);
    const { op, manage } = await who(req, hotelId);
    if (!manage) throw forbidden('Missing permission: keycards.manage');
    const id = z.string().uuid().parse((req.params as any).readId);
    const b = z.object({
      validUntil: z.string().datetime().refine((v) => Date.parse(v) > Date.now() + 60_000 && Date.parse(v) < Date.now() + 3653 * 86_400_000, 'The new expiry date must be in the future (at most ten years ahead).'),
      reactivate: z.boolean().default(false), encoder: Encoder.optional(),
    }).parse(req.body);
    const c = await one(pool, `SELECT status, result, payload, completed_at FROM commands WHERE id=$1 AND hotel_id=$2 AND type='READ_CARD'`, [id, hotelId]);
    if (!c || c.status !== 'SUCCEEDED') throw notFound('Card read');
    if (Date.now() - new Date(c.completed_at).getTime() > 15 * 60_000) throw conflict('READ_TOO_OLD', 'Read the card on the encoder again (the reading is more than 15 minutes old).');
    const done = await one(pool, `SELECT id FROM commands WHERE hotel_id=$1 AND type='ENCODE_KEYCARD' AND payload->'context'->>'readId'=$2 AND status IN ('PENDING','LEASED','SUCCEEDED')`, [hotelId, id]);
    if (done) throw conflict('ALREADY_EXTENDED', 'This reading was already used: read the card again.');
    const r = c.result ?? {};
    const pol = await policy(hotelId);
    const encoder = b.encoder ?? c.payload?.encoder;
    if (!pol.encodeEnabled) throw conflict('ENCODE_OFF', 'Encoding from the portal is switched off (Settings → Keycards & encoders). Extend the card in Visionline.');
    if (!pol.encoders.includes(encoder)) throw badRequest('UNKNOWN_ENCODER', 'This encoder is not one chosen for encoding (Settings → Keycards & encoders).');
    if (encoder !== c.payload?.encoder) throw badRequest('OTHER_ENCODER', 'Extend the card on the encoder it was read on.');
    if (!r.regNo || !r.cardHolder || r.mobile) throw conflict('NOT_A_STAFF_CARD', 'Only a staff keycard read at the encoder can be extended.');
    const tz = (await getConfig(pool, hotelId, 'property'))?.timezone ?? process.env.HOTEL_TIMEZONE ?? 'UTC';
    const exp = readExpiry(r.expireTime, tz);
    const ended = Boolean(r.cancelled || r.overridden || r.expired || (exp && exp.getTime() <= Date.now()));
    if (ended && !b.reactivate) throw conflict('CARD_ENDED', 'This card had ended or was cancelled. Confirm that it should work again.');
    const ops = ((r.operations ?? []) as { operation: string; doors: string[]; doorGroups: string[] }[]).filter((o) => o.doors?.length || o.doorGroups?.length);
    const simple = ops.length ? ops.every((o) => o.operation === 'normal' && !o.doorGroups?.length) : !(r.doorGroups ?? []).length;
    const conn = await connectorWith(hotelId, 'encode-operations');
    if (!conn.online) throw new ApiError(409, 'CONNECTOR_OFFLINE', 'The connector is offline.');
    if (!simple && !conn.has) throw new ApiError(409, 'CONNECTOR_CAPABILITY', 'This card has door groups or special door operations: extending it needs connector 0.16.0.');
    const doors = (r.doors ?? []) as string[];
    if (!doors.length && !ops.length) throw conflict('NO_DOORS', 'Visionline gave no doors for this card.');
    const payload = {
      kind: 'staff', encoder, cardHolder: r.cardHolder, doorIds: simple ? doors : [], onOffDoorIds: [], expireTime: b.validUntil,
      ...(r.timeSchedule ? { timeSchedule: r.timeSchedule } : {}), ...(simple ? {} : { operations: ops }),
      // One staff card per person in Visionline: the holder's other staff cards stop; the card on the encoder is rewritten.
      override: true, overwriteValidCard: true,
      context: { step: 'extend', readId: id, fromRegNo: String(r.regNo), holder: r.cardHolder, reactivated: ended },
    };
    const cmd = await enqueue(pool, { hotelId, type: 'ENCODE_KEYCARD', payload, idempotencyKey: `kc-extend:${id}:${Date.now()}`, correlationId: newCorrelationId(), ttlSec: 180, requestedBy: op.id });
    await audit(null, { hotelId, actorType: 'operator', actorId: op.id, action: ended ? 'keycard.reactivate_requested' : 'keycard.extend_requested', targetType: 'card', targetId: String(r.regNo),
      details: { encoder, holder: r.cardHolder, from: exp?.toISOString() ?? null, to: b.validUntil, commandId: cmd.id } });
    return { commandId: cmd.id };
  });
}

/** After the extended card was written: the register and the request follow the new card number and date. */
export async function onKeycardExtended(c: pg.PoolClient, cmd: any, result: { status: string; result?: any }) {
  const ctx = cmd.payload?.context ?? {};
  if (result.status !== 'SUCCEEDED') return;
  const reg = result.result?.regNo ? String(result.result.regNo) : null;
  const by = (await one(c, 'SELECT display_name FROM operators WHERE id=$1', [cmd.requested_by]))?.display_name ?? 'Portal user';
  const what = `${ctx.reactivated ? 'Keycard made valid again' : 'Keycard extended'} to ${String(cmd.payload.expireTime).slice(0, 10)} at ${cmd.payload.encoder}${reg && reg !== ctx.fromRegNo ? ` (new Visionline card ${reg}, was ${ctx.fromRegNo})` : ''}`;
  await c.query(`UPDATE keycard_register SET card_reg_no=COALESCE($3, card_reg_no), status='in_use', updated_at=now() WHERE hotel_id=$1 AND card_reg_no=$2`, [cmd.hotel_id, ctx.fromRegNo, reg]);
  await c.query(`UPDATE keycard_requests SET card_reg_no=COALESCE($3, card_reg_no), valid_until=$4, updated_at=now(), history = history || $5::jsonb
      WHERE hotel_id=$1 AND card_reg_no=$2 AND kind <> 'cancel'`, [cmd.hotel_id, ctx.fromRegNo, reg, cmd.payload.expireTime, JSON.stringify([{ at: new Date().toISOString(), by, what }])]);
  await audit(c, { hotelId: cmd.hotel_id, actorType: 'operator', actorId: cmd.requested_by, action: ctx.reactivated ? 'keycard.reactivated' : 'keycard.extended', targetType: 'card', targetId: reg ?? ctx.fromRegNo,
    details: { from: ctx.fromRegNo, to: reg, until: cmd.payload.expireTime } });
  // The portal's lists follow: the holder's keycards are read again from Visionline (one person).
  setImmediate(() => void requestDirectorySync(cmd.hotel_id, cmd.requested_by ?? null, { userIds: [ctx.holder] }).catch(() => undefined));
}
