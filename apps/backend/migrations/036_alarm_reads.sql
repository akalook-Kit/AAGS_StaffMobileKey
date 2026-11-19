-- 2.38 Alarms read every 15 minutes, and battery alarms completed in Visionline by the portal once new batteries are
-- in [Web API §5.4.1 POST /alarms/{id}].
ALTER TABLE vl_alarms ADD COLUMN IF NOT EXISTS complete_requested_at timestamptz;
ALTER TABLE vl_alarms ADD COLUMN IF NOT EXISTS complete_reason text CHECK (complete_reason IS NULL OR length(complete_reason) <= 200);
ALTER TABLE vl_alarms ADD COLUMN IF NOT EXISTS completed_by_portal boolean NOT NULL DEFAULT false;
ALTER TABLE vl_alarms ADD COLUMN IF NOT EXISTS complete_error text CHECK (complete_error IS NULL OR length(complete_error) <= 200);
CREATE INDEX IF NOT EXISTS vl_alarms_open_idx ON vl_alarms (hotel_id, door_id) WHERE NOT completed;
