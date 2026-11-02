-- 2.19 Lock troubleshooting: the lock model of each report (remembered per door) and the elimination checklist.
ALTER TABLE lock_reports ADD COLUMN IF NOT EXISTS lock_model text;
ALTER TABLE lock_reports ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS door_lock_models (
  hotel_id   uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  door_id    text NOT NULL,
  model      text NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, door_id)
);

-- 2.19 Gateways of the online locks (Visionline online system): name, EEID, address, the doors they serve, and their
-- state, worked out from Visionline alarms and the doors behind them (later also from the network integrator).
CREATE TABLE IF NOT EXISTS gateways (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  eeid          text CHECK (eeid IS NULL OR length(eeid) <= 64),
  address       text CHECK (address IS NULL OR length(address) <= 120),
  location      text CHECK (location IS NULL OR length(location) <= 120),
  notes         text CHECK (notes IS NULL OR length(notes) <= 1000),
  doors         text[] NOT NULL DEFAULT '{}',
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'integrator')),
  state         text NOT NULL DEFAULT 'unknown' CHECK (state IN ('online', 'offline', 'unknown')),
  reason        text,
  changed_at    timestamptz,
  checked_at    timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gateways_eeid ON gateways (hotel_id, upper(eeid)) WHERE eeid IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateways_hotel ON gateways (hotel_id);
