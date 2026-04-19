-- Migration: add_inventory_rls


-- food_categories: read-only for all authenticated users
ALTER TABLE food_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view categories"
    ON food_categories FOR SELECT
    TO authenticated
    USING (true);


-- inventory_items: full access scoped to household membership
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Household members can view items"
    ON inventory_items FOR SELECT
    USING (
        household_id IN (
            SELECT household_id FROM household_members
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Household members can insert items"
    ON inventory_items FOR INSERT
    WITH CHECK (
        household_id IN (
            SELECT household_id FROM household_members
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Household members can update items"
    ON inventory_items FOR UPDATE
    USING (
        household_id IN (
            SELECT household_id FROM household_members
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Household members can delete items"
    ON inventory_items FOR DELETE
    USING (
        household_id IN (
            SELECT household_id FROM household_members
            WHERE user_id = auth.uid()
        )
    );
