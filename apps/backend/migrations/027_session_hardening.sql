-- 2.20 Security review: sessions issued before a password change, a password link or a two-step reset stop working
-- (each account has a session version, written into its sessions); a two-step code cannot be used twice.
ALTER TABLE operators ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 0;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS totp_last_step bigint;
