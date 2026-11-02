-- 2.21 Who issued each keycard (Armel, 31 Oct: "Visionline desk" becomes "Issued from Visionline", with the Visionline
-- operator and the person behind that operator; staff keycards record who issued them).

-- A Visionline operator name linked to the portal user who is that person (set by an administrator; a user's own
-- verified Visionline sign-in links automatically).
CREATE TABLE IF NOT EXISTS vl_operator_links (
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  vl_operator text NOT NULL CHECK (length(vl_operator) BETWEEN 1 AND 80),
  operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  linked_by   uuid REFERENCES operators(id) ON DELETE SET NULL,
  linked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vl_operator_links_name ON vl_operator_links (hotel_id, lower(vl_operator));

-- Card issuers now also come from the portal (a card recorded as issued from Visionline, with its operator).
ALTER TABLE vl_card_issuers ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'card_log';
ALTER TABLE vl_card_issuers ADD COLUMN IF NOT EXISTS recorded_by uuid REFERENCES operators(id) ON DELETE SET NULL;

-- Staff keycards: who issued the card and when (handled_by changes again when the card is collected).
ALTER TABLE keycard_requests ADD COLUMN IF NOT EXISTS issued_by uuid REFERENCES operators(id) ON DELETE SET NULL;
ALTER TABLE keycard_requests ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE keycard_requests ADD COLUMN IF NOT EXISTS vl_operator text CHECK (vl_operator IS NULL OR length(vl_operator) <= 80);
-- Earlier issues: the history names who issued (encoded / made in Visionline / linked); the operator is matched by name.
UPDATE keycard_requests k SET issued_at = h.at, issued_by = (SELECT o.id FROM operators o WHERE o.display_name = h.by LIMIT 1)
  FROM (SELECT k2.id, (e->>'at')::timestamptz AS at, e->>'by' AS by, row_number() OVER (PARTITION BY k2.id ORDER BY (e->>'at')::timestamptz) AS n
        FROM keycard_requests k2, jsonb_array_elements(k2.history) e
        WHERE e->>'what' ~ '^(Sent to encoder|Made at the Visionline desk|Linked to the existing Visionline keycard)') h
  WHERE h.id = k.id AND h.n = 1 AND k.issued_at IS NULL;

/** The "issued by" label of a keycard made in Visionline, when its operator is known. */
CREATE OR REPLACE FUNCTION vl_issuer_label(h uuid, reg text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT 'Issued from Visionline · ' || i.operator || COALESCE(' (' || o.display_name || ')', '')
  FROM vl_card_issuers i
  LEFT JOIN LATERAL (
    SELECT l.operator_id FROM vl_operator_links l WHERE l.hotel_id = i.hotel_id AND lower(l.vl_operator) = lower(i.operator)
    UNION ALL
    SELECT c.operator_id FROM operator_vl_credentials c WHERE c.hotel_id = i.hotel_id AND lower(c.username) = lower(i.operator) AND c.status = 'VERIFIED'
    LIMIT 1) who ON true
  LEFT JOIN operators o ON o.id = who.operator_id
  WHERE i.hotel_id = h AND i.reg_no = reg
$$;

-- Low-battery alerts clear after 2 accepted staff keycards (was 3), also on sites that saved the setting.
INSERT INTO hotel_config_versions (hotel_id, kind, version, data, created_by)
SELECT v.hotel_id, v.kind, v.version + 1, jsonb_set(v.data, '{battery,clearAfterCards}', '2'), NULL
FROM (SELECT DISTINCT ON (hotel_id, kind) * FROM hotel_config_versions WHERE kind = 'policy' ORDER BY hotel_id, kind, version DESC) v
WHERE v.data #>> '{battery,clearAfterCards}' = '3';

-- Generic-name keycards already e-mailed to the site's administrators (each card once).
CREATE TABLE IF NOT EXISTS generic_card_notices (
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  reg_no      text NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, reg_no)
);
