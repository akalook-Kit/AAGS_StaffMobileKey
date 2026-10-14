-- 2.6: event log and printed reports.
-- Every PDF the platform prints is recorded with the SHA-256 of its exact bytes, so a printed or e-mailed copy can be
-- checked later (Event log -> Verify a PDF): any change to the file changes the fingerprint.
CREATE TABLE IF NOT EXISTS report_prints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id),
  report      text NOT NULL,
  title       text NOT NULL,
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  rows        int NOT NULL DEFAULT 0,
  pages       int NOT NULL DEFAULT 0,
  sha256      text NOT NULL,
  bytes       int NOT NULL,
  created_by  uuid REFERENCES operators(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_prints_hash_idx ON report_prints (hotel_id, sha256);
CREATE INDEX IF NOT EXISTS report_prints_time_idx ON report_prints (hotel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS visionline_events_time_idx ON visionline_events (hotel_id, received_at DESC);
CREATE INDEX IF NOT EXISTS commands_failed_idx ON commands (hotel_id, completed_at DESC) WHERE status IN ('FAILED', 'EXPIRED');
