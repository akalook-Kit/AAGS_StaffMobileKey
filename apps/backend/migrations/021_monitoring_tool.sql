-- 2.17 Mobile keys are not finished for general use: switch the module off where it was never used.
INSERT INTO hotel_config_versions (hotel_id, kind, version, data, created_by)
SELECT v.hotel_id, 'features', v.version + 1, v.data || '{"staffMobileKeys": false}'::jsonb, NULL
FROM (SELECT DISTINCT ON (hotel_id) hotel_id, version, data FROM hotel_config_versions WHERE kind='features' ORDER BY hotel_id, version DESC) v
WHERE COALESCE((v.data->>'staffMobileKeys')::boolean, false)
  AND NOT EXISTS (SELECT 1 FROM key_requests k WHERE k.hotel_id = v.hotel_id);

-- 2.17 Notice board: short posts shown on the sign-in page and the Overview.
CREATE TABLE IF NOT EXISTS notices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  body        text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  kind        text NOT NULL DEFAULT 'info' CHECK (kind IN ('info', 'important', 'tip', 'event')),
  public      boolean NOT NULL DEFAULT false,      -- also on the sign-in page (before sign-in)
  pinned      boolean NOT NULL DEFAULT false,
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  created_by  uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notices_hotel_idx ON notices (hotel_id, starts_at DESC);

-- 2.17 Reports exported from Visionline (System settings, operators, card log), imported by an administrator.
CREATE TABLE IF NOT EXISTS vl_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('system_settings', 'operators', 'card_log', 'user_groups', 'other')),
  file_name   text NOT NULL,
  data        jsonb NOT NULL,
  rows        int NOT NULL DEFAULT 0,
  imported_by uuid REFERENCES operators(id) ON DELETE SET NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vl_imports_idx ON vl_imports (hotel_id, kind, imported_at DESC);

-- Who issued each keycard, from Visionline's card log (the Web API does not say).
CREATE TABLE IF NOT EXISTS vl_card_issuers (
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  reg_no      text NOT NULL,
  operator    text NOT NULL,
  issued_at   timestamptz,
  import_id   uuid REFERENCES vl_imports(id) ON DELETE CASCADE,
  PRIMARY KEY (hotel_id, reg_no)
);
ALTER TABLE notices ADD COLUMN IF NOT EXISTS image text CHECK (image IS NULL OR (image ~ '^data:image/(jpeg|png|webp);base64,' AND length(image) <= 560000));
