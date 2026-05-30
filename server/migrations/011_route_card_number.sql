-- 011_route_card_number.sql
-- Add route_card_number to timers table
-- Makes each assembly uniquely identifiable within a works order batch

ALTER TABLE timers ADD COLUMN IF NOT EXISTS route_card_number TEXT;

COMMENT ON COLUMN timers.route_card_number IS
  'Individual assembly identifier within a works order batch (e.g. "3 of 10"). '
  'Combined with wo_number and item_number, uniquely identifies a single assembly.';
