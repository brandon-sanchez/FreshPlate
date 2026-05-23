-- Storage-aware shelf life. Each (category, storage) cell is days-until-expiration
-- as a sensible middle for that combination. NULL means "not safe / not recommended
-- in this storage location" — the UI should warn instead of suggesting a number.
--
-- Sources:
--   USDA FoodSafety.gov cold-storage chart
--   FSIS shelf-stable foods guidance
--   FSIS leftovers and food safety
-- Researched 2026-05-23 against the live USDA pages.

ALTER TABLE food_categories
  ADD COLUMN IF NOT EXISTS fridge_days  INT,
  ADD COLUMN IF NOT EXISTS freezer_days INT,
  ADD COLUMN IF NOT EXISTS pantry_days  INT;

UPDATE food_categories SET fridge_days = 7,    freezer_days = 240,  pantry_days = 7    WHERE name = 'Produce';
UPDATE food_categories SET fridge_days = 14,   freezer_days = 30,   pantry_days = NULL WHERE name = 'Dairy & Eggs';
UPDATE food_categories SET fridge_days = 2,    freezer_days = 120,  pantry_days = NULL WHERE name = 'Meat & Seafood';
UPDATE food_categories SET fridge_days = 2,    freezer_days = 240,  pantry_days = NULL WHERE name = 'Frozen';
UPDATE food_categories SET fridge_days = 7,    freezer_days = 90,   pantry_days = 14   WHERE name = 'Grains & Bread';
UPDATE food_categories SET fridge_days = 4,    freezer_days = NULL, pantry_days = 1095 WHERE name = 'Canned Goods';
UPDATE food_categories SET fridge_days = 180,  freezer_days = NULL, pantry_days = 365  WHERE name = 'Condiments';
UPDATE food_categories SET fridge_days = NULL, freezer_days = NULL, pantry_days = 60   WHERE name = 'Snacks';
UPDATE food_categories SET fridge_days = 7,    freezer_days = NULL, pantry_days = 365  WHERE name = 'Beverages';
UPDATE food_categories SET fridge_days = 4,    freezer_days = 90,   pantry_days = NULL WHERE name = 'Leftovers';
UPDATE food_categories SET fridge_days = 7,    freezer_days = 90,   pantry_days = 30   WHERE name = 'Other';
