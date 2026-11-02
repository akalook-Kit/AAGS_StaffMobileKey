-- 2.13 Personal preferences of portal users (menu items they hide, appearance), staff profiles for ID cards,
-- portal usage counts (for the hotel and, in a signed summary, for the supplier) and emergency activations.
ALTER TABLE operators ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}';
-- Staff ID profiles (printed on the keycard, used for time & attendance): anyone, linked when known to a Visionline
-- user, a mobile-key staff record or an attendance person. The photo is a small JPEG resized in the browser.
CREATE TABLE IF NOT EXISTS id_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  full_name    text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  id_number    text CHECK (length(id_number) <= 40),
  department   text CHECK (length(department) <= 80),
  job_title    text CHECK (length(job_title) <= 80),
  photo        text CHECK (photo IS NULL OR (photo LIKE 'data:image/jpeg;base64,%' AND length(photo) <= 400000)),
  valid_until  date,
  vl_user_id   text,
  staff_id     uuid REFERENCES staff(id) ON DELETE SET NULL,
  ta_person_id uuid REFERENCES ta_people(id) ON DELETE SET NULL,
  active       boolean NOT NULL DEFAULT true,
  printed_at   timestamptz,
  print_count  int NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS id_profiles_number_uq ON id_profiles (hotel_id, lower(id_number)) WHERE id_number IS NOT NULL AND active;
CREATE UNIQUE INDEX IF NOT EXISTS id_profiles_vl_uq ON id_profiles (hotel_id, vl_user_id) WHERE vl_user_id IS NOT NULL AND active;
CREATE TABLE IF NOT EXISTS usage_daily (
  hotel_id   uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  day        date NOT NULL,
  area       text NOT NULL,
  operator_id uuid NOT NULL,
  n          int NOT NULL DEFAULT 0,
  PRIMARY KEY (hotel_id, day, area, operator_id)
);
CREATE TABLE IF NOT EXISTS emergencies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('fire', 'evacuation', 'drill', 'other')),
  status       text NOT NULL CHECK (status IN ('REQUESTED', 'ACTIVE', 'ENDED', 'CANCELLED')),
  reason       text NOT NULL,
  requested_by uuid NOT NULL REFERENCES operators(id),
  confirmed_by uuid REFERENCES operators(id),
  ended_by     uuid REFERENCES operators(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  ended_at     timestamptz,
  roll         jsonb NOT NULL DEFAULT '{}',   -- roll call: person key -> { safe: true, by, at }
  actions      jsonb NOT NULL DEFAULT '[]'    -- what was done (emergency keys issued, lists printed…)
);
CREATE INDEX IF NOT EXISTS emergencies_hotel_idx ON emergencies (hotel_id, requested_at DESC);
