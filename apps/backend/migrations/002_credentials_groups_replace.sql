-- Iteration 2: sealed Visionline credentials, user-group templates, key replacement, building addresses.

-- The connector's public sealing key (the private key never leaves the Visionline PC).
ALTER TABLE connectors ADD COLUMN seal_public_key text;
ALTER TABLE connectors ADD COLUMN seal_key_id text;

-- Operators' personal Visionline credentials: username in clear (it is shown, like the vendor portal),
-- password only as a blob sealed for the connector. Re-entry is needed if the connector is reinstalled.
CREATE TABLE operator_vl_credentials (
  operator_id  uuid NOT NULL REFERENCES operators(id),
  hotel_id     uuid NOT NULL REFERENCES hotels(id),
  username     text NOT NULL,
  sealed       jsonb NOT NULL,
  key_id       text NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','FAILED')),
  status_detail text,
  verified_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, hotel_id)
);

-- Access templates can include the doors of Visionline user groups (role-based access, spec §12.4).
ALTER TABLE access_templates ADD COLUMN user_group_ids text[] NOT NULL DEFAULT '{}';

-- Key replacement ("change doors") uses Visionline override; the old key is revoked by Visionline.
ALTER TABLE key_requests ADD COLUMN replaces_key_id uuid REFERENCES key_requests(id);
ALTER TABLE key_requests ADD COLUMN replaced_by_key_id uuid REFERENCES key_requests(id);
-- Visionline operator the key was issued as (personal or property), for traceability.
ALTER TABLE key_requests ADD COLUMN issued_as text;

-- Staff import provenance.
ALTER TABLE staff ADD COLUMN source text NOT NULL DEFAULT 'manual';
