-- 2.37 Current consumption test (ASSA ABLOY manual 66 1100 042-0, case CS0055208): the current the lock draws in
-- micro-amperes, measured with the parts connected one at a time (LCA only, LCA + LCU, with and without the online end
-- node), so the part that draws the current shows. Values in µA; an object of up to 6 named readings.
ALTER TABLE lock_work ADD COLUMN IF NOT EXISTS current_ua jsonb CHECK (current_ua IS NULL OR (jsonb_typeof(current_ua) = 'object' AND octet_length(current_ua::text) <= 400));
