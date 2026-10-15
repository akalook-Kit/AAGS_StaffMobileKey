-- 2.7 Monitoring: alerts (doors offline, connector, disk, database, VIP entrances, lock alarms, batteries),
-- e-mail / SMS contacts, watched (VIP) doors and system samples for trends.

-- One row per problem. An open alert has resolved_at NULL; a problem that comes back later is a new row.
CREATE TABLE IF NOT EXISTS monitor_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  kind          text NOT NULL,       -- door_offline | connector_offline | visionline_unreachable | disk_low | db_large | vip_entrance | lock_alarm | battery_critical | test
  subject       text NOT NULL DEFAULT '',   -- door id, disk path, ...
  severity      text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title         text NOT NULL,
  detail        text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES operators(id),
  notified_at   timestamptz,
  resolved_notified_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_alerts_open_uq ON monitor_alerts (hotel_id, kind, subject) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS monitor_alerts_time_idx ON monitor_alerts (hotel_id, opened_at DESC);

-- Door contact: when each lock last reported anything to Visionline (via the connector's watch) and its state.
CREATE TABLE IF NOT EXISTS door_status (
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  door_id       text NOT NULL,
  state         text NOT NULL DEFAULT 'unknown' CHECK (state IN ('online', 'offline', 'unknown')),
  last_event_at timestamptz,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  reason        text,
  PRIMARY KEY (hotel_id, door_id)
);
CREATE INDEX IF NOT EXISTS visionline_events_door_idx ON visionline_events (hotel_id, door_id, received_at DESC) WHERE kind = 'event';

-- People told about alerts, by e-mail and/or SMS, per alert category.
CREATE TABLE IF NOT EXISTS alert_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id),
  name        text NOT NULL,
  email       text,
  phone       text,
  by_email    boolean NOT NULL DEFAULT true,
  by_sms      boolean NOT NULL DEFAULT false,
  categories  text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_contacts_hotel_idx ON alert_contacts (hotel_id) WHERE active;

-- Every message sent or attempted (addresses masked).
CREATE TABLE IF NOT EXISTS alert_messages (
  id          bigserial PRIMARY KEY,
  hotel_id    uuid NOT NULL REFERENCES hotels(id),
  alert_id    uuid REFERENCES monitor_alerts(id),
  contact_id  uuid REFERENCES alert_contacts(id) ON DELETE SET NULL,
  channel     text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient   text NOT NULL,
  subject     text,
  status      text NOT NULL CHECK (status IN ('sent', 'failed')),
  error       text,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_messages_time_idx ON alert_messages (hotel_id, sent_at DESC);

-- Watched doors (VIP rooms, suites, cash office ...): first entrance highlighted and announced.
CREATE TABLE IF NOT EXISTS watched_doors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  door_id       text NOT NULL,
  label         text NOT NULL,
  mode          text NOT NULL DEFAULT 'first_daily' CHECK (mode IN ('first_daily', 'first_once', 'every')),
  watch_from    timestamptz NOT NULL DEFAULT now(),
  watch_until   timestamptz,
  active        boolean NOT NULL DEFAULT true,
  last_entrance_at timestamptz,
  last_alert_day   date,
  created_by    uuid REFERENCES operators(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, door_id)
);

-- Hourly samples of database size and free disk space (trend on System health).
CREATE TABLE IF NOT EXISTS system_samples (
  at          timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL,          -- 'platform' or 'connector:<id>'
  db_bytes    bigint,
  disk_path   text,
  disk_free   bigint,
  disk_total  bigint,
  PRIMARY KEY (source, at)
);

-- New configuration kind: how alerts reach people (e-mail / SMS settings; secrets stay outside the database).
ALTER TABLE hotel_config_versions DROP CONSTRAINT IF EXISTS hotel_config_versions_kind_check;
ALTER TABLE hotel_config_versions ADD CONSTRAINT hotel_config_versions_kind_check
  CHECK (kind IN ('branding','property','features','policy','visionline','credential_services','app_policy','notifications'));
