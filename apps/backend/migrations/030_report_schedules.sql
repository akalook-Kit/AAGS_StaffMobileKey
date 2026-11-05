-- 2.27 Reports sent by e-mail on a schedule: the previous day every morning, or the previous month on the 1st.
CREATE TABLE IF NOT EXISTS report_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  report      text NOT NULL CHECK (length(report) <= 60),
  frequency   text NOT NULL CHECK (frequency IN ('daily', 'monthly')),
  send_time   text NOT NULL DEFAULT '07:00' CHECK (send_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  emails      text[] NOT NULL CHECK (cardinality(emails) BETWEEN 1 AND 20),
  enabled     boolean NOT NULL DEFAULT true,
  last_period text,
  last_sent_at timestamptz,
  last_error  text,
  created_by  uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_schedules_idx ON report_schedules (hotel_id);
