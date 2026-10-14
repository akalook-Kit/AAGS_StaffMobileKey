-- Iteration 3: Visionline watch (cards cancelled at the Visionline desk, refused doors), revoke source/method.
ALTER TABLE key_requests
  ADD COLUMN IF NOT EXISTS revoke_source text,          -- operator | visionline | wrong_door | replaced
  ADD COLUMN IF NOT EXISTS revoke_method text,          -- checkout | cancelCard
  ADD COLUMN IF NOT EXISTS wrong_door_count int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS key_requests_credential_idx ON key_requests (hotel_id, credential_id);

-- What the connector reported from Visionline /callback or its catch-up query [Web API §7.14, §5.9.3].
CREATE TABLE IF NOT EXISTS visionline_events (
  id                  bigserial PRIMARY KEY,
  hotel_id            uuid NOT NULL REFERENCES hotels(id),
  received_at         timestamptz NOT NULL DEFAULT now(),
  batch_id            text NOT NULL,
  source              text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('card', 'event')),
  registration_number text,
  card_status         int,
  event_code          int,
  door_id             text,
  event_time          text,
  key_id              uuid REFERENCES key_requests(id),
  dedupe              text NOT NULL,
  UNIQUE (hotel_id, dedupe)
);
CREATE INDEX IF NOT EXISTS visionline_events_key_idx ON visionline_events (hotel_id, key_id, received_at);
