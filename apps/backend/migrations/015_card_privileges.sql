-- 2.12 Keycard privileges read from Visionline: the door operations on the card (e.g. "normal") and whether the card
-- may override the deadbolt / privacy, when Visionline reports it (NULL = Visionline did not say).
ALTER TABLE vl_cards ADD COLUMN IF NOT EXISTS operations text[] NOT NULL DEFAULT '{}';
ALTER TABLE vl_cards ADD COLUMN IF NOT EXISTS deadbolt_override boolean;
