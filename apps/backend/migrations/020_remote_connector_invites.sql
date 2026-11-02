-- 2.16 Connector on another computer (the address it reports from), and invitations for new portal users.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS last_address text;

-- A one-time link with which a new person sets their own password. Only the SHA-256 of the link's secret is kept.
CREATE TABLE IF NOT EXISTS operator_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  operator_id  uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS operator_invites_op_idx ON operator_invites (operator_id, created_at DESC);
