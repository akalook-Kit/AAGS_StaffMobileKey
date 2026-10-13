-- Phase 2: lock battery monitoring and maintenance requests (spec Phase 2, §12.6, §13.4).

-- Current battery state per door, from Visionline battery events [Web API §7.14.1]. No row = never reported.
CREATE TABLE IF NOT EXISTS battery_status (
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  door_id          text NOT NULL,                 -- resources.external_id of the door
  state            text NOT NULL CHECK (state IN ('GOOD','LOW','CRITICAL','REPORTED')),
  last_event_code  int NOT NULL,
  volts_below      numeric(4,1),                  -- last "Battery level below X volts" value, if any
  reported_at      timestamptz NOT NULL,          -- when the lock recorded the event (hotel time converted)
  received_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, door_id)
);

-- Every battery event received, for history and export.
CREATE TABLE IF NOT EXISTS battery_readings (
  id               bigserial PRIMARY KEY,
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  door_id          text NOT NULL,
  event_code       int NOT NULL,
  state            text NOT NULL,
  volts_below      numeric(4,1),
  reported_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  visionline_event_id bigint REFERENCES visionline_events(id),
  reporting_registration_number text            -- card that triggered the event, when there was one
);
CREATE INDEX IF NOT EXISTS battery_readings_door_idx ON battery_readings (hotel_id, door_id, reported_at DESC);

-- At most one open alert per door; repeats update it instead of raising new alerts (duplicate suppression).
CREATE TABLE IF NOT EXISTS battery_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  door_id          text NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('LOW','CRITICAL')),
  status           text NOT NULL CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  occurrences      int NOT NULL DEFAULT 1,
  acknowledged_by  uuid REFERENCES operators(id),
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  resolved_reason  text,
  ticket_id        uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS battery_alerts_one_open ON battery_alerts (hotel_id, door_id) WHERE status IN ('OPEN','ACKNOWLEDGED');

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  number           int NOT NULL,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  category         text NOT NULL DEFAULT 'other' CHECK (category IN ('battery','lock','door','room','electrical','plumbing','other')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ON_HOLD','RESOLVED','CLOSED','CANCELLED')),
  door_id          text,
  location         text,
  asset            text,
  source           text NOT NULL CHECK (source IN ('portal','app','battery')),
  battery_alert_id uuid REFERENCES battery_alerts(id),
  assignee_staff_id uuid,
  created_by_type  text NOT NULL CHECK (created_by_type IN ('operator','staff','system')),
  created_by_id    text,
  due_at           timestamptz,
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  closed_at        timestamptz,
  resolution       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, number),
  FOREIGN KEY (hotel_id, assignee_staff_id) REFERENCES staff(hotel_id, id)
);
CREATE INDEX IF NOT EXISTS maintenance_tickets_status_idx ON maintenance_tickets (hotel_id, status);
CREATE INDEX IF NOT EXISTS maintenance_tickets_assignee_idx ON maintenance_tickets (hotel_id, assignee_staff_id);
ALTER TABLE battery_alerts ADD CONSTRAINT battery_alerts_ticket_fk FOREIGN KEY (ticket_id) REFERENCES maintenance_tickets(id);

-- Resolution history: every change and comment, in order.
CREATE TABLE IF NOT EXISTS maintenance_activity (
  id               bigserial PRIMARY KEY,
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  ticket_id        uuid NOT NULL REFERENCES maintenance_tickets(id),
  at               timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('operator','staff','system')),
  actor_id         text,
  actor_name       text,
  kind             text NOT NULL,                 -- created | comment | status | assigned | priority | due | edited | attachment | battery
  body             text,
  data             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS maintenance_activity_ticket_idx ON maintenance_activity (ticket_id, id);

CREATE TABLE IF NOT EXISTS maintenance_attachments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  ticket_id        uuid NOT NULL REFERENCES maintenance_tickets(id),
  filename         text NOT NULL,
  content_type     text NOT NULL,
  size_bytes       int NOT NULL,
  data             bytea NOT NULL,
  uploaded_by_type text NOT NULL,
  uploaded_by_id   text,
  uploaded_by_name text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_attachments_ticket_idx ON maintenance_attachments (ticket_id);
