-- Polling mode (on-premises, CS_CALLBACKS=off): when the platform last asked Credential Services about an issued key,
-- so that keys removed on the vendor side (phone deleted, Visionline override, expiry) are noticed without callbacks.
ALTER TABLE key_requests ADD COLUMN IF NOT EXISTS vendor_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS key_requests_vendor_check_idx ON key_requests (vendor_checked_at NULLS FIRST) WHERE status = 'ISSUED' AND credential_id IS NOT NULL;
