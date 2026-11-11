-- 2.34 Lock diagnosis for the light edition (Armel, 11 Nov): the battery voltage at rest and under load (the
-- technician's "idle and loaded" readings), the door a part was swapped from (LCA / LCU taken from a lock that works,
-- to see whether the fault follows the part), and photos or screenshots of the paper log, the multimeter or the
-- battery holder.
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS volts_idle numeric(4,2) CHECK (volts_idle IS NULL OR volts_idle BETWEEN 0 AND 12);
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS volts_loaded numeric(4,2) CHECK (volts_loaded IS NULL OR volts_loaded BETWEEN 0 AND 12);
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS swapped_from text CHECK (swapped_from IS NULL OR length(swapped_from) <= 100);

CREATE TABLE IF NOT EXISTS lock_work_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id   uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  work_id    uuid NOT NULL REFERENCES lock_work(id) ON DELETE CASCADE,
  file_name  text NOT NULL CHECK (length(file_name) <= 160),
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes      integer NOT NULL CHECK (bytes BETWEEN 1 AND 3145728),
  data       bytea NOT NULL,
  created_by uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lock_work_files_work ON lock_work_files (hotel_id, work_id);
