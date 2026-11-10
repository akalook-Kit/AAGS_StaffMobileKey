-- 2.32 What the technician measured: the battery pack voltage before and after the work (a multimeter), and the batch
-- of the batteries fitted, so a weak or old batch is seen.
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS volts_before numeric(4,2) CHECK (volts_before IS NULL OR volts_before BETWEEN 0 AND 12);
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS volts_after numeric(4,2) CHECK (volts_after IS NULL OR volts_after BETWEEN 0 AND 12);
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS battery_batch text CHECK (battery_batch IS NULL OR length(battery_batch) <= 60);
