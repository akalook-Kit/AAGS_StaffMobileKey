-- 2.12 Licensing. Each hotel runs on a licence key signed by the vendor (Ed25519). Installations without a key run
-- as a trial from the moment this migration ran (existing installations are never locked by the upgrade).
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS licence_trial_from timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS hotel_licences (
  hotel_id     uuid PRIMARY KEY REFERENCES hotels(id) ON DELETE CASCADE,
  licence      text NOT NULL,
  payload      jsonb NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid REFERENCES operators(id) ON DELETE SET NULL
);
