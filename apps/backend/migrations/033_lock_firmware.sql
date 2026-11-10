-- 2.32 Lock firmware upgrades (Armel, 9 Nov: "the locks were working fine before I upgraded the firmware in December
-- 2025"): when, from which version to which, on all locks or some; and the version seen on a lock when work is done.
CREATE TABLE IF NOT EXISTS lock_firmware_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  done_on      date NOT NULL,
  version_from text CHECK (version_from IS NULL OR length(version_from) <= 40),
  version_to   text CHECK (version_to IS NULL OR length(version_to) <= 40),
  doors        text[],              -- NULL = every lock of the site
  notes        text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by   uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lock_firmware_events_hotel ON lock_firmware_events (hotel_id, done_on);
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS firmware_version text CHECK (firmware_version IS NULL OR length(firmware_version) <= 40);
