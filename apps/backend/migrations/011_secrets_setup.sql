-- 2.9 Passwords and keys entered in the portal (Credential Services, SMTP, SMS), encrypted.
-- AES-256-GCM with a key that is not in the database (SMK_SECRET_KEY, kept by the server in its encrypted
-- settings). The portal can set or remove a value but never read it back.
CREATE TABLE IF NOT EXISTS platform_secrets (
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  ref         text NOT NULL CHECK (ref ~ '^[A-Z0-9_]{1,60}$'),
  sealed      bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES operators(id) ON DELETE SET NULL,
  PRIMARY KEY (hotel_id, ref)
);
