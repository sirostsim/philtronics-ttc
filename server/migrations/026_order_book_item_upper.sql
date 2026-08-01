-- 026_order_book_item_upper.sql
-- Normalise existing customer_orders.item_number to uppercase.
--
-- target_times and planned_work both store item_number uppercased, but the order
-- book import historically only trimmed it. When the SAP export's case differed,
-- the offering's target-time join, planned-qty subquery, planner drift and £ value
-- matching all silently missed -- making target items look like no-target items
-- and defeating backward scheduling (jobs defaulted to today). The import now
-- uppercases on insert; this fixes rows already stored. Idempotent.

UPDATE customer_orders
   SET item_number = UPPER(TRIM(item_number))
 WHERE item_number <> UPPER(TRIM(item_number));
