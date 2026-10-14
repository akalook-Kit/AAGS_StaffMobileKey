-- The Visionline card registration number (card id) of a mobile key is not its credentialID (hotel/vendor
-- answer, 13 Oct). The connector looks it up after creating the key; callbacks and lock events use it.
ALTER TABLE key_requests ADD COLUMN IF NOT EXISTS card_reg_no text;
CREATE INDEX IF NOT EXISTS key_requests_card_reg_idx ON key_requests (hotel_id, card_reg_no);
