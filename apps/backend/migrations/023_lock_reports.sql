-- 2.18 Lock troubleshooting: event reports of single (mostly offline) locks, uploaded from Visionline.
-- Kept: the door, the period, the analysis and the events as (lock time, code, name, "(*)" mark, card type).
-- Never kept: names, user IDs, card numbers or "issued by" from the report.
CREATE TABLE IF NOT EXISTS lock_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  door_id      text NOT NULL,
  door_name    text NOT NULL,
  file_name    text NOT NULL,
  date_order   text NOT NULL,
  period_from  text,
  period_to    text,
  events       integer NOT NULL,
  analysis     jsonb NOT NULL,
  lock_events  jsonb NOT NULL,
  uploaded_by  uuid REFERENCES operators(id) ON DELETE SET NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lock_reports_hotel_door ON lock_reports (hotel_id, door_id, uploaded_at DESC);
