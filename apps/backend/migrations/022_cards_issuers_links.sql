-- 2.17 Mobile keys made in Visionline (their "card serial" is FFFFFFFF: a phone, not a plastic card).
ALTER TABLE vl_cards ADD COLUMN IF NOT EXISTS mobile boolean;
-- Every keycard encoded from this portal: who did it (the Visionline Web API does not tell who encoded a card).
CREATE TABLE IF NOT EXISTS portal_encoded_cards (
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  reg_no      text NOT NULL,
  kind        text NOT NULL,
  operator_id uuid REFERENCES operators(id) ON DELETE SET NULL,
  operator_name text,
  encoded_at  timestamptz NOT NULL DEFAULT now(),
  command_id  uuid,
  PRIMARY KEY (hotel_id, reg_no)
);
-- A portal user can also be a Visionline card holder (an operator with keycards).
CREATE TABLE IF NOT EXISTS operator_vl_links (
  operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  vl_user_id  text NOT NULL,
  linked_by   uuid REFERENCES operators(id) ON DELETE SET NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, hotel_id)
);
ALTER TABLE commands ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES operators(id) ON DELETE SET NULL;
