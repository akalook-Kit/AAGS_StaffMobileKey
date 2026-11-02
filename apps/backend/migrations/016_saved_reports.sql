-- 2.12 Reports people build themselves in Insights ("Build your own report"): the definition only, never the data.
CREATE TABLE IF NOT EXISTS insight_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  spec        jsonb NOT NULL,
  pinned      boolean NOT NULL DEFAULT false,
  shared      boolean NOT NULL DEFAULT false,
  position    int NOT NULL DEFAULT 0,
  created_by  uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS insight_reports_hotel_idx ON insight_reports (hotel_id, created_by);
