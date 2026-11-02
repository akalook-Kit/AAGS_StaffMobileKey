-- 2.11 Breakfast. The in-house list (who stays, from when to when, with or without breakfast) comes from the
-- PMS report (CSV import) or front office; later straight from the PMS. The restaurant records who was served.
CREATE TABLE IF NOT EXISTS bf_stays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room          text NOT NULL CHECK (length(room) BETWEEN 1 AND 20),
  guest_name    text,
  adults        int  NOT NULL DEFAULT 1 CHECK (adults BETWEEN 0 AND 20),
  children      int  NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 20),
  arrival       date NOT NULL,
  departure     date NOT NULL CHECK (departure > arrival),
  breakfast     boolean NOT NULL DEFAULT true,
  note          text,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','pms')),
  external_ref  text,
  checked_out_at timestamptz,
  ended_on      date,          -- left early / no longer on the PMS list: not in house from this day on
  created_by    uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bf_stays_day_idx ON bf_stays (hotel_id, arrival, departure);
CREATE UNIQUE INDEX IF NOT EXISTS bf_stays_ref_uq ON bf_stays (hotel_id, external_ref) WHERE external_ref IS NOT NULL;

-- Every serving is a record; mistakes are voided with a reason, never deleted.
CREATE TABLE IF NOT EXISTS bf_served (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  day           date NOT NULL,
  room          text,
  stay_id       uuid REFERENCES bf_stays(id) ON DELETE SET NULL,
  persons       int  NOT NULL CHECK (persons BETWEEN 1 AND 30),
  kind          text NOT NULL CHECK (kind IN ('included','paying','walk_in')),
  note          text,
  served_at     timestamptz NOT NULL DEFAULT now(),
  served_by     uuid REFERENCES operators(id) ON DELETE SET NULL,
  voided_at     timestamptz,
  voided_by     uuid REFERENCES operators(id) ON DELETE SET NULL,
  void_reason   text
);
CREATE INDEX IF NOT EXISTS bf_served_day_idx ON bf_served (hotel_id, day);
