-- 2.30 Work done on a lock (parts changed or checked, batteries and their type), for the elimination method: the
-- portal judges each piece of work from the lock reports uploaded afterwards.
CREATE TABLE IF NOT EXISTS lock_work (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  door_id      text NOT NULL,
  done_on      date NOT NULL,
  parts        text[] NOT NULL CHECK (cardinality(parts) BETWEEN 1 AND 30),
  other_part   text CHECK (other_part IS NULL OR length(other_part) <= 120),
  battery_type text CHECK (battery_type IS NULL OR battery_type IN ('industrial-alkaline', 'alkaline', 'lithium', 'rechargeable', 'unknown')),
  battery_brand text CHECK (battery_brand IS NULL OR length(battery_brand) <= 60),
  done_by      text CHECK (done_by IS NULL OR length(done_by) <= 80),
  notes        text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by   uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lock_work_door ON lock_work (hotel_id, door_id, done_on);
