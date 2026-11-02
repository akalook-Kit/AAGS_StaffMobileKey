-- 2.15 When were a lock's batteries last changed, and is it still alarming afterwards?
-- Source: "Battery exchanged" events (528/535/536), an abrupt rise in "Battery level below X volts" readings, or a
-- maintenance request resolved with "battery replaced".
ALTER TABLE battery_status
  ADD COLUMN IF NOT EXISTS last_change_at      timestamptz,
  ADD COLUMN IF NOT EXISTS last_change_source  text CHECK (last_change_source IN ('event', 'inferred', 'maintenance')),
  ADD COLUMN IF NOT EXISTS last_change_detail  text,
  ADD COLUMN IF NOT EXISTS reprogram_ticket_id uuid REFERENCES maintenance_tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reprogram_at        timestamptz;
ALTER TABLE battery_readings ADD COLUMN IF NOT EXISTS change_inferred boolean NOT NULL DEFAULT false;
