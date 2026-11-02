-- 2.20 Every battery change of a lock (not only the last), so the portal can say how many days each set lasted.
CREATE TABLE IF NOT EXISTS battery_changes (
  id         bigserial PRIMARY KEY,
  hotel_id   uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  door_id    text NOT NULL,
  at         timestamptz NOT NULL,
  source     text NOT NULL CHECK (source IN ('event', 'inferred', 'maintenance')),
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, door_id, at)
);
CREATE INDEX IF NOT EXISTS battery_changes_door ON battery_changes (hotel_id, door_id, at DESC);
-- Backfill: changes already known from battery readings (exchanged events, voltage jumps) and the last change of each door.
INSERT INTO battery_changes (hotel_id, door_id, at, source, detail)
SELECT hotel_id, door_id, reported_at, CASE WHEN event_code IN (528, 535, 536) THEN 'event' ELSE 'inferred' END,
       CASE WHEN event_code IN (528, 535, 536) THEN 'Battery exchanged' ELSE 'Battery level rose' END
FROM battery_readings WHERE event_code IN (528, 535, 536) OR change_inferred
ON CONFLICT DO NOTHING;
INSERT INTO battery_changes (hotel_id, door_id, at, source, detail)
SELECT hotel_id, door_id, last_change_at, last_change_source, last_change_detail FROM battery_status WHERE last_change_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- 2.20 A low-battery alarm clears itself when the lock accepts several cards in a row without raising the low flag again.
ALTER TABLE battery_status ADD COLUMN IF NOT EXISTS cards_since_low int NOT NULL DEFAULT 0;
