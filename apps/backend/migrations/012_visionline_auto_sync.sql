-- 2.10 Visionline data arrives by itself: doors and user groups are read on a schedule, people and keycards are
-- synced automatically, and a card issued at the Visionline desk is recorded within seconds (partial syncs).
ALTER TABLE directory_syncs ADD COLUMN IF NOT EXISTS partial boolean NOT NULL DEFAULT false;
ALTER TABLE directory_syncs ADD COLUMN IF NOT EXISTS user_ids text[];
-- Where a card row came from: a full or partial sync, or straight from the live Visionline feed.
ALTER TABLE vl_cards ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'sync';
ALTER TABLE vl_cards ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS vl_cards_seen_idx ON vl_cards (hotel_id, first_seen_at DESC);
