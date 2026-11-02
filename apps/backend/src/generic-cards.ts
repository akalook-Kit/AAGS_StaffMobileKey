import { genericCardName } from '@smk/shared';
import { many, pool } from './db.ts';

/**
 * 2.20 Valid staff keycards held under a name that is not a person ("Staff", "HK 2", "Spare", a number...): they cannot
 * be traced to someone. Mobile keys are left out.
 */
export async function genericCards(hotelId: string) {
  const rows = await many(pool, `SELECT c.reg_no, c.card_holder, c.user_group, c.expires_at, u.given_name, u.surname
    FROM vl_cards c LEFT JOIN vl_users u ON u.hotel_id=c.hotel_id AND u.user_id=c.card_holder
    WHERE c.hotel_id=$1 AND c.active AND NOT (c.cancelled OR c.discarded OR c.overridden OR c.expired) AND c.key_id IS NULL AND NOT COALESCE(c.mobile, false)
      AND (c.expires_at IS NULL OR c.expires_at > now()) ORDER BY c.user_group NULLS LAST, c.card_holder LIMIT 5000`, [hotelId]);
  return rows.map((r) => ({ regNo: r.reg_no as string, holder: r.card_holder as string | null, name: [r.given_name, r.surname].filter(Boolean).join(' ') || (r.card_holder as string | null), group: r.user_group as string | null, expiresAt: r.expires_at }))
    .filter((x) => genericCardName(x.name)).slice(0, 500);
}

