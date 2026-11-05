-- 2.25 A demo site for testers (Armel, 2 Nov: "a ready to deploy and one time usage that I can share with users to
-- test and share feedback"). The Demo Hotel holds made-up data only; testers belong to it alone, get a one-time
-- invitation link and their access ends after a set number of days. Feedback is kept per site.
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS access_until timestamptz;
ALTER TABLE operator_invites ADD COLUMN IF NOT EXISTS access_days int CHECK (access_days IS NULL OR access_days BETWEEN 1 AND 60);
CREATE TABLE IF NOT EXISTS feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  operator_id uuid REFERENCES operators(id) ON DELETE SET NULL,
  page        text CHECK (page IS NULL OR length(page) <= 200),
  rating      int CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  text        text NOT NULL CHECK (length(text) BETWEEN 2 AND 3000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_idx ON feedback (hotel_id, created_at DESC);
