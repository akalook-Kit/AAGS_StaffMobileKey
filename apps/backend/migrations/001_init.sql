-- Staff Mobile Key platform — Phase 1 schema.
-- Every hotel-owned row carries hotel_id; all queries are scoped by it (tenant isolation, spec §2).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE hotels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  name         text NOT NULL,
  timezone     text NOT NULL DEFAULT 'UTC',
  status       text NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Versioned tenant configuration (branding, property, features, policy, integration settings).
-- Secrets are never stored here.
CREATE TABLE hotel_config_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id),
  kind         text NOT NULL CHECK (kind IN ('branding','property','features','policy','visionline','credential_services','app_policy')),
  version      int  NOT NULL,
  data         jsonb NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, kind, version)
);

CREATE TABLE operators (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  password_hash    text,             -- local dev accounts only; production uses federated IdP
  idp_subject      text UNIQUE,
  totp_secret      text,
  mfa_enabled      boolean NOT NULL DEFAULT false,
  is_platform_admin boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  last_sign_in_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  operator_id  uuid NOT NULL REFERENCES operators(id),
  hotel_id     uuid NOT NULL REFERENCES hotels(id),
  role         text NOT NULL,
  PRIMARY KEY (operator_id, hotel_id, role)
);

CREATE TABLE staff (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL REFERENCES hotels(id),
  full_name          text NOT NULL,
  email              text NOT NULL,
  employee_no        text,
  job_role           text NOT NULL DEFAULT 'Housekeeper',
  visionline_user    text,
  visionline_user_group text,
  password_hash      text,   -- dev sign-in for the mobile app; production uses the hotel IdP
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','LEFT')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, email),
  UNIQUE (hotel_id, id)
);

-- Credential Services endpoints (one per phone). Invitation codes are never stored.
CREATE TABLE endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id             uuid NOT NULL REFERENCES hotels(id),
  staff_id             uuid NOT NULL,
  endpoint_id          text NOT NULL UNIQUE,         -- Credential Services endpointId (UUID we generate)
  status               text NOT NULL CHECK (status IN ('INVITED','ACTIVE','DELETED','FAILED')),
  vendor_status        text,                          -- last Credential Services endpointStatus seen
  device_label         text,
  invitation_expires_at timestamptz,
  activated_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (hotel_id, staff_id) REFERENCES staff(hotel_id, id)
);
CREATE UNIQUE INDEX one_live_endpoint_per_staff ON endpoints (staff_id) WHERE status IN ('INVITED','ACTIVE');

-- Visionline resources discovered by the connector (doors, groups, schedules, accounts).
CREATE TABLE resources (
  hotel_id     uuid NOT NULL REFERENCES hotels(id),
  kind         text NOT NULL CHECK (kind IN ('door','doorgroup','usergroup','timeschedule','mobileaccessaccount')),
  external_id  text NOT NULL,
  name         text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, kind, external_id)
);

CREATE TABLE access_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL REFERENCES hotels(id),
  name               text NOT NULL,
  description        text,
  door_ids           text[] NOT NULL DEFAULT '{}',
  door_group_ids     text[] NOT NULL DEFAULT '{}',
  allowed_job_roles  text[] NOT NULL DEFAULT '{}',   -- empty = any
  is_broad           boolean NOT NULL DEFAULT false,
  max_validity_hours int NOT NULL DEFAULT 12,
  time_schedule      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, name)
);

CREATE TABLE connectors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL REFERENCES hotels(id),
  name               text NOT NULL,
  token_hash         text NOT NULL UNIQUE,
  installation_uuid  uuid,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_seen_at       timestamptz,
  health             jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE key_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  staff_id         uuid NOT NULL,
  endpoint_id      text NOT NULL,
  template_id      uuid REFERENCES access_templates(id),
  requested_by     uuid NOT NULL REFERENCES operators(id),
  approved_by      uuid REFERENCES operators(id),
  status           text NOT NULL,
  is_broad         boolean NOT NULL DEFAULT false,
  reason           text,
  requested_scope  jsonb NOT NULL,     -- exactly what the requester asked for
  resolved_scope   jsonb,              -- exactly what Visionline accepted
  starts_at        timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  credential_id    text,               -- Visionline credentialID (= Credential Services credentialId)
  vendor_status    text,               -- last Credential Services credentialStatus
  first_used_at    timestamptz,        -- READBACK callback: first use at a door
  last_used_door   text,
  failure_code     text,
  failure_message  text,
  correlation_id   text NOT NULL,
  idempotency_key  text NOT NULL,
  revoked_by       uuid REFERENCES operators(id),
  revoke_requested boolean NOT NULL DEFAULT false,  -- revoke asked while the issue command was in flight
  revoke_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, idempotency_key),
  FOREIGN KEY (hotel_id, staff_id) REFERENCES staff(hotel_id, id),
  CHECK (expires_at > starts_at)
);
CREATE INDEX key_requests_status ON key_requests (hotel_id, status);
CREATE INDEX key_requests_credential ON key_requests (credential_id);

CREATE TABLE commands (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL REFERENCES hotels(id),
  type             text NOT NULL,
  payload          jsonb NOT NULL,
  idempotency_key  text NOT NULL,
  correlation_id   text NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','LEASED','SUCCEEDED','FAILED','EXPIRED')),
  attempts         int NOT NULL DEFAULT 0,
  leased_by        uuid REFERENCES connectors(id),
  lease_until      timestamptz,
  expires_at       timestamptz NOT NULL,
  result           jsonb,
  error            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  UNIQUE (hotel_id, idempotency_key)
);
CREATE INDEX commands_pending ON commands (hotel_id, status, created_at);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id),
  staff_id    uuid NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Credential Services callbacks. Kept so callbacks that arrive before the connector reports the
-- credentialID can be applied later, and so duplicate deliveries are ignored.
CREATE TABLE inbound_events (
  event_hash    text PRIMARY KEY,
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  callback_type text NOT NULL,
  credential_id text,
  endpoint_id   text,
  payload       jsonb NOT NULL,
  processed     boolean NOT NULL DEFAULT false,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_unprocessed ON inbound_events (hotel_id, credential_id) WHERE NOT processed;

-- Append-only, hash-chained audit trail (spec §3, §6).
CREATE TABLE audit_log (
  seq            bigserial PRIMARY KEY,
  hotel_id       uuid REFERENCES hotels(id),
  at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type     text NOT NULL CHECK (actor_type IN ('operator','staff','connector','system','vendor')),
  actor_id       text,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  correlation_id text,
  details        jsonb NOT NULL DEFAULT '{}',
  prev_hash      text NOT NULL,
  hash           text NOT NULL
);
CREATE INDEX audit_hotel_seq ON audit_log (hotel_id, seq);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
