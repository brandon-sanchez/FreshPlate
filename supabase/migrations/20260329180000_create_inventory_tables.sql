-- Migration: create_inventory_tables

-- Reference table: food categories
CREATE TABLE food_categories (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    default_shelf_life_days INT,
    icon TEXT
);

-- Seed default categories (reference data needed by the app)
INSERT INTO food_categories (name, default_shelf_life_days, icon) VALUES
    ('Produce',        7, 'leaf'),
    ('Dairy & Eggs',  14, 'tint'),
    ('Meat & Seafood', 5, 'cutlery'),
    ('Frozen',        90, 'snowflake-o'),
    ('Grains & Bread', 7, 'square'),
    ('Canned Goods', 365, 'archive'),
    ('Condiments',   180, 'eyedropper'),
    ('Snacks',        30, 'star-o'),
    ('Beverages',     14, 'coffee'),
    ('Leftovers',      3, 'inbox'),
    ('Other',         14, 'question-circle-o');

-- Main table: inventory items
CREATE TABLE inventory_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    category_id UUID REFERENCES food_categories(id) ON DELETE SET NULL,
    added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (char_length(name) > 0),
    quantity NUMERIC(7, 2) NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'item',
    expiration_date DATE,
    storage_location TEXT NOT NULL DEFAULT 'fridge'
        CHECK (storage_location IN ('fridge', 'freezer', 'pantry')),
    is_leftover BOOLEAN NOT NULL DEFAULT false,
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_inventory_items_household ON inventory_items(household_id);
CREATE INDEX idx_inventory_items_category ON inventory_items(category_id);
CREATE INDEX idx_inventory_items_expiration ON inventory_items(household_id, expiration_date)
    WHERE expiration_date IS NOT NULL;

-- Auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_inventory_items_updated_at
    BEFORE UPDATE ON inventory_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
