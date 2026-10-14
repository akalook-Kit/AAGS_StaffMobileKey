-- Management reports: read-only snapshot of Visionline people, valid keycards and lock alarms (opt-in).
-- Personal data kept to the minimum: user id, names and user group. No PIN, e-mail, phone or card serials.

CREATE TABLE IF NOT EXISTS directory_syncs (
  id            uuid PRIMARY KEY,                 -- the SYNC_DIRECTORY command id
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  requested_by  uuid REFERENCES operators(id),    -- null = scheduled
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  users         int NOT NULL DEFAULT 0,
  cards         int NOT NULL DEFAULT 0,
  alarms        int NOT NULL DEFAULT 0,
  notes         jsonb NOT NULL DEFAULT '[]',
  error         text
);
CREATE INDEX IF NOT EXISTS directory_syncs_hotel_idx ON directory_syncs (hotel_id, started_at DESC);

CREATE TABLE IF NOT EXISTS vl_users (
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  user_id       text NOT NULL,
  surname       text,
  given_name    text,
  user_group    text,
  seen_sync     uuid,
  active        boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, user_id)
);
CREATE INDEX IF NOT EXISTS vl_users_group_idx ON vl_users (hotel_id, user_group) WHERE active;

-- Cards that were valid at the time of the sync (GET /cards?cardHolder=&validTime=now), with their state flags.
CREATE TABLE IF NOT EXISTS vl_cards (
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  reg_no        text NOT NULL,
  card_holder   text,
  user_group    text,                             -- holder's group at sync time
  format        text,
  starts_at     timestamptz,
  expires_at    timestamptz,
  cancelled     boolean NOT NULL DEFAULT false,
  discarded     boolean NOT NULL DEFAULT false,
  overridden    boolean NOT NULL DEFAULT false,
  expired       boolean NOT NULL DEFAULT false,
  not_issued    boolean NOT NULL DEFAULT false,
  issued_count  int,
  door_count    int NOT NULL DEFAULT 0,
  doors         text[] NOT NULL DEFAULT '{}',
  door_groups   text[] NOT NULL DEFAULT '{}',
  time_schedule text,
  key_id        uuid REFERENCES key_requests(id), -- set when the card is a mobile key issued by this platform
  seen_sync     uuid,
  active        boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, reg_no)
);
CREATE INDEX IF NOT EXISTS vl_cards_holder_idx ON vl_cards (hotel_id, card_holder) WHERE active;

CREATE TABLE IF NOT EXISTS vl_alarms (
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  alarm_id      text NOT NULL,
  alarm_type    text,
  type_name     text,
  alarm_text    text,
  alarm_at      timestamptz,
  door_id       text,                             -- discovered door external id when it matches
  door_raw      text,
  card_holder   text,
  completed     boolean NOT NULL DEFAULT false,
  completed_at  timestamptz,
  updated_at    timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, alarm_id)
);
CREATE INDEX IF NOT EXISTS vl_alarms_time_idx ON vl_alarms (hotel_id, alarm_at DESC);

-- Daily counts per user group, so trends survive later syncs.
CREATE TABLE IF NOT EXISTS vl_card_counts (
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  sync_id       uuid NOT NULL REFERENCES directory_syncs(id),
  taken_at      timestamptz NOT NULL DEFAULT now(),
  user_group    text NOT NULL,
  users         int NOT NULL,
  valid_cards   int NOT NULL,
  mobile_keys   int NOT NULL,
  PRIMARY KEY (sync_id, user_group)
);
