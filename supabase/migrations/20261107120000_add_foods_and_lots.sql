-- Migration: add_foods_and_lots
--
-- Expand step of the foods-and-lots inventory model (spec #104). A food is a
-- thing the household keeps (Milk, Garlic) with one stock base: grams,
-- millilitres or a count of each_label. A lot is one physical batch of that
-- food, with its own amount, date and location. Every quantity change goes
-- through an RPC; members may edit only non-quantity lot fields directly.
--
-- inventory_items and cook_recipe are untouched. The backfill, the switch of
-- app callers and the drop of the old table come in later migrations.

CREATE TYPE public.stock_base AS ENUM ('g', 'ml', 'each');

-- Normalizes a food name for duplicate detection: case-insensitive, with
-- surrounding whitespace trimmed and inner runs collapsed to one space, so
-- "Milk", " milk " and "MILK" are the same food within a household. This is
-- the only normalizer; the inventory_items backfill must use it too.
CREATE FUNCTION public.food_name_key(name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
$$;

-- A finite, positive amount or fact. The "< 'Infinity'" bound matters: numeric
-- NaN sorts above Infinity, so it rejects NaN and infinities that "> 0" accepts.
CREATE DOMAIN public.positive_amount AS NUMERIC
    CHECK (VALUE > 0 AND VALUE < 'Infinity');

-- A unit or package word, stored lowercased and trimmed so lookups and lot
-- merges compare words, not spellings.
CREATE DOMAIN public.unit_label AS TEXT
    CHECK (VALUE <> '' AND VALUE = lower(btrim(VALUE)));

-- Global reference facts about generic foods. Written by the service role only.
CREATE TABLE public.food_profiles (
    profile_key TEXT PRIMARY KEY CHECK (profile_key <> ''),
    g_per_ml public.positive_amount,
    unit_grams JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(unit_grams) = 'object'),
    source TEXT NOT NULL CHECK (source IN ('usda', 'manual', 'llm')),
    source_ref TEXT
);

CREATE TABLE public.foods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    category_id UUID REFERENCES public.food_categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (char_length(name) <= 80 AND public.food_name_key(name) <> ''),
    name_key TEXT GENERATED ALWAYS AS (public.food_name_key(name)) STORED,
    profile_key TEXT REFERENCES public.food_profiles(profile_key),
    stock_base public.stock_base NOT NULL,
    each_label public.unit_label,
    grams_per_each public.positive_amount,
    ml_per_each public.positive_amount,
    g_per_ml public.positive_amount,
    whole_units_only BOOLEAN NOT NULL DEFAULT false,
    -- Foods are archived, never deleted, so lots and cook history keep resolving.
    archived_at TIMESTAMPTZ,
    merged_into_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (household_id, name_key),
    UNIQUE (id, household_id),
    -- Composite so a food can only be merged into a food of the same household.
    FOREIGN KEY (merged_into_id, household_id) REFERENCES public.foods(id, household_id),
    CHECK ((stock_base = 'each') = (each_label IS NOT NULL)),
    CHECK (NOT whole_units_only OR stock_base = 'each'),
    CHECK (merged_into_id IS DISTINCT FROM id),
    CHECK (merged_into_id IS NULL OR archived_at IS NOT NULL)
);

-- Household words for one food, in that food's stock base: clove = 0.1 head.
CREATE TABLE public.food_units (
    food_id UUID NOT NULL,
    household_id UUID NOT NULL,
    unit_key public.unit_label NOT NULL,
    base_per_unit public.positive_amount NOT NULL,
    PRIMARY KEY (food_id, unit_key),
    FOREIGN KEY (food_id, household_id)
        REFERENCES public.foods(id, household_id) ON DELETE CASCADE
);

CREATE TABLE public.lots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_id UUID NOT NULL,
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    -- Amounts are in the food's stock base.
    quantity NUMERIC NOT NULL CHECK (quantity >= 0 AND quantity < 'Infinity'),
    -- The "full" amount. Null for lots backfilled from inventory_items, whose
    -- original amount is unknown.
    initial_quantity public.positive_amount,
    package_size public.positive_amount,
    package_label public.unit_label,
    is_estimate BOOLEAN NOT NULL DEFAULT false,
    expiration_date DATE,
    opened_at TIMESTAMPTZ,
    storage_location TEXT NOT NULL
        CHECK (storage_location IN ('fridge', 'freezer', 'pantry')),
    source_cook_event_id UUID REFERENCES public.cook_events(id) ON DELETE SET NULL,
    depleted_at TIMESTAMPTZ,
    depleted_reason TEXT CHECK (depleted_reason IN ('used', 'tossed', 'corrected')),
    added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Also the lot's version: the planned set_lot_remaining RPC (spec #104)
    -- compares it to detect stale writes.
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (food_id, household_id) REFERENCES public.foods(id, household_id),
    -- A tossed lot keeps its amount for waste history; only an empty lot must
    -- be depleted.
    CHECK (quantity > 0 OR depleted_at IS NOT NULL),
    CHECK ((depleted_at IS NULL) = (depleted_reason IS NULL))
);

CREATE INDEX idx_foods_category ON public.foods(category_id);
CREATE INDEX idx_foods_profile ON public.foods(profile_key);
CREATE INDEX idx_foods_merged_into ON public.foods(merged_into_id, household_id)
    WHERE merged_into_id IS NOT NULL;
CREATE INDEX idx_food_units_household ON public.food_units(household_id);
CREATE INDEX idx_lots_household ON public.lots(household_id);
CREATE INDEX idx_lots_food ON public.lots(food_id, household_id);
CREATE INDEX idx_lots_added_by ON public.lots(added_by) WHERE added_by IS NOT NULL;
CREATE INDEX idx_lots_source_cook_event ON public.lots(source_cook_event_id)
    WHERE source_cook_event_id IS NOT NULL;
CREATE INDEX idx_lots_live_merge_lookup
    ON public.lots(food_id, storage_location, expiration_date)
    WHERE depleted_at IS NULL;

CREATE TRIGGER set_foods_updated_at
    BEFORE UPDATE ON public.foods
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER set_lots_updated_at
    BEFORE UPDATE ON public.lots
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- A food's stock base is fixed once it has any lot, depleted ones included:
-- restore and Cook Again read old lot amounts in the food's current base.
CREATE FUNCTION public.guard_food_stock_base()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF (NEW.stock_base IS DISTINCT FROM OLD.stock_base
        OR NEW.each_label IS DISTINCT FROM OLD.each_label)
        AND EXISTS (SELECT 1 FROM public.lots WHERE food_id = OLD.id) THEN
        RAISE EXCEPTION 'A food''s stock base cannot change once it has lots'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.whole_units_only AND NOT OLD.whole_units_only
        AND EXISTS (
            SELECT 1 FROM public.lots
            WHERE food_id = OLD.id
              AND (quantity <> trunc(quantity) OR initial_quantity <> trunc(initial_quantity))
        ) THEN
        RAISE EXCEPTION 'Food has fractional lots, so it cannot be whole units only'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_foods_stock_base
    BEFORE UPDATE ON public.foods
    FOR EACH ROW EXECUTE FUNCTION public.guard_food_stock_base();

CREATE FUNCTION public.guard_lot_food()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_whole_units_only BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.food_id <> OLD.food_id THEN
        RAISE EXCEPTION 'A lot cannot move to another food' USING ERRCODE = '23514';
    END IF;
    -- FOR SHARE locks the food row against concurrent updates in both
    -- directions: this read waits for an uncommitted whole_units_only switch and
    -- sees its result, and a later stock base change waits for this lot to
    -- commit, so guard_food_stock_base sees the lot.
    SELECT whole_units_only INTO v_whole_units_only
    FROM public.foods WHERE id = NEW.food_id
    FOR SHARE;
    IF v_whole_units_only
        AND (NEW.quantity <> trunc(NEW.quantity)
            OR NEW.initial_quantity <> trunc(NEW.initial_quantity)) THEN
        RAISE EXCEPTION 'This food is counted in whole units only'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_lots_food
    BEFORE INSERT OR UPDATE OF quantity, initial_quantity, food_id ON public.lots
    FOR EACH ROW EXECUTE FUNCTION public.guard_lot_food();

-- Per-food stock for the inventory list and recipe generation. Expired lots
-- count only toward expired_quantity until someone reviews them.
CREATE VIEW public.food_stock WITH (security_invoker = true) AS
SELECT
    f.id, f.household_id, f.category_id, f.name, f.profile_key, f.stock_base,
    f.each_label, f.grams_per_each, f.ml_per_each, f.g_per_ml, f.whole_units_only,
    f.created_at, f.updated_at,
    coalesce(sum(l.quantity) FILTER (
        WHERE l.expiration_date IS NULL OR l.expiration_date >= current_date), 0) AS available,
    coalesce(sum(l.quantity) FILTER (WHERE l.expiration_date < current_date), 0)
        AS expired_quantity,
    min(l.expiration_date) FILTER (WHERE l.expiration_date >= current_date) AS soonest_expiry,
    count(l.id) AS lot_count,
    coalesce(bool_or(l.is_estimate), false) AS any_estimate
FROM public.foods f
LEFT JOIN public.lots l ON l.food_id = f.id AND l.depleted_at IS NULL
WHERE f.archived_at IS NULL
GROUP BY f.id;

-- Returns the caller's user id, or raises unless they belong to the household.
-- Every inventory RPC starts with this check.
CREATE FUNCTION public.require_household_member(p_household_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.household_members hm
        WHERE hm.household_id = p_household_id AND hm.user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'Household membership required' USING ERRCODE = '42501';
    END IF;
    RETURN v_user_id;
END;
$$;

-- Takes the per-food transaction locks that every RPC changing a food's stock
-- holds, in sorted id order so two RPCs locking the same foods cannot
-- deadlock. This is the one definition of the lock key.
CREATE FUNCTION public.lock_foods(p_food_ids UUID[])
RETURNS VOID
LANGUAGE sql
SET search_path = ''
AS $$
    SELECT pg_advisory_xact_lock(hashtextextended('food:' || food_id::text, 0))
    FROM (SELECT DISTINCT unnest(p_food_ids) AS food_id ORDER BY 1) ids;
$$;

-- Adds a batch of food for a household member and returns
-- {food_id, lot_id, food_created, lot_merged}.
--
-- Finds the food by normalized name, creating it if new, follows merges to the
-- live food and unarchives it. The amount must already be in the food's stock
-- base; a request in another base fails with STOCK_BASE_MISMATCH (backend code
-- does unit conversion). The amount merges into a full, unopened live lot with
-- the same date, location, package and note, otherwise it starts a new lot. Food
-- attributes (category, each_label, sizes) apply only when the food is created.
--
-- SECURITY DEFINER so that members get no direct INSERT on foods or lots and
-- no UPDATE of lot quantities. It bypasses RLS, so every statement after the
-- membership check filters by p_household_id.
CREATE FUNCTION public.add_lot(
    p_household_id UUID,
    p_name TEXT,
    p_stock_base public.stock_base,
    p_quantity NUMERIC,
    p_storage_location TEXT,
    p_expiration_date DATE DEFAULT NULL,
    p_category_id UUID DEFAULT NULL,
    p_each_label TEXT DEFAULT NULL,
    p_whole_units_only BOOLEAN DEFAULT false,
    p_grams_per_each NUMERIC DEFAULT NULL,
    p_ml_per_each NUMERIC DEFAULT NULL,
    p_package_size NUMERIC DEFAULT NULL,
    p_package_label TEXT DEFAULT NULL,
    p_is_estimate BOOLEAN DEFAULT false,
    p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := public.require_household_member(p_household_id);
    v_name TEXT := btrim(regexp_replace(p_name, '\s+', ' ', 'g'));
    v_name_key TEXT := public.food_name_key(p_name);
    v_each_label TEXT := nullif(lower(btrim(p_each_label)), '');
    v_package_label TEXT := nullif(lower(btrim(p_package_label)), '');
    v_notes TEXT := nullif(btrim(p_notes), '');
    v_food public.foods;
    v_food_id UUID;
    v_food_created BOOLEAN := false;
    v_lot_id UUID;
    v_lot_merged BOOLEAN;
    v_hops INTEGER := 0;
BEGIN
    IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity') THEN
        RAISE EXCEPTION 'Quantity must be finite and positive' USING ERRCODE = '22023';
    END IF;
    IF p_stock_base IS NULL OR coalesce(v_name_key, '') = '' OR char_length(v_name) > 80 THEN
        RAISE EXCEPTION 'Name must be 1 to 80 characters, with a stock base'
            USING ERRCODE = '22023';
    END IF;
    IF (p_stock_base = 'each') <> (v_each_label IS NOT NULL) THEN
        RAISE EXCEPTION 'each_label is required for stock base each, and only for it'
            USING ERRCODE = '22023';
    END IF;
    IF p_whole_units_only AND p_stock_base <> 'each' THEN
        RAISE EXCEPTION 'Only foods counted in each can be whole units only'
            USING ERRCODE = '22023';
    END IF;

    -- Look up first so that adding to an existing food never evaluates the
    -- new-food attributes, which the INSERT below would check even on conflict.
    SELECT id INTO v_food_id FROM public.foods
    WHERE household_id = p_household_id AND name_key = v_name_key;
    IF v_food_id IS NULL THEN
        INSERT INTO public.foods(household_id, category_id, name, stock_base, each_label,
            whole_units_only, grams_per_each, ml_per_each)
        VALUES (p_household_id, p_category_id, v_name, p_stock_base, v_each_label,
            coalesce(p_whole_units_only, false), p_grams_per_each, p_ml_per_each)
        ON CONFLICT (household_id, name_key) DO NOTHING
        RETURNING id INTO v_food_id;
        v_food_created := v_food_id IS NOT NULL;
    END IF;
    IF v_food_id IS NULL THEN
        -- A concurrent insert of the same name has committed by now, because
        -- ON CONFLICT waited for it, and this new statement sees it.
        SELECT id INTO v_food_id FROM public.foods
        WHERE household_id = p_household_id AND name_key = v_name_key;
    END IF;
    IF v_food_id IS NULL THEN
        -- The food was renamed between the conflict and the re-select.
        RAISE EXCEPTION 'Food changed while adding; retry' USING ERRCODE = '40001';
    END IF;

    -- Follow merges to the live food. Each hop re-reads under the food's lock,
    -- and FOR SHARE makes the stock base check below wait for, and see, any
    -- uncommitted change to the food row.
    LOOP
        PERFORM public.lock_foods(ARRAY[v_food_id]);
        SELECT * INTO v_food FROM public.foods
        WHERE id = v_food_id AND household_id = p_household_id
        FOR SHARE;
        EXIT WHEN v_food.merged_into_id IS NULL;
        v_hops := v_hops + 1;
        IF v_hops > 8 THEN
            RAISE EXCEPTION 'Food merge chain is too long' USING ERRCODE = '55000';
        END IF;
        v_food_id := v_food.merged_into_id;
    END LOOP;

    IF v_food.stock_base <> p_stock_base
        OR v_food.each_label IS DISTINCT FROM v_each_label THEN
        RAISE EXCEPTION 'STOCK_BASE_MISMATCH'
            USING ERRCODE = '22023',
                  DETAIL = format('Food %s is stored as %s%s', v_food.id, v_food.stock_base,
                      coalesce(' (' || v_food.each_label || ')', ''));
    END IF;

    IF v_food.archived_at IS NOT NULL THEN
        UPDATE public.foods SET archived_at = NULL
        WHERE id = v_food_id AND household_id = p_household_id;
    END IF;

    -- Only a full lot is a merge target. A partly used lot, or a backfilled
    -- lot whose original amount is unknown, stays its own batch. A note that
    -- differs from the lot's keeps the batch apart rather than being dropped.
    SELECT id INTO v_lot_id FROM public.lots
    WHERE food_id = v_food_id AND household_id = p_household_id
      AND depleted_at IS NULL AND opened_at IS NULL
      AND quantity = initial_quantity
      AND storage_location = p_storage_location
      AND expiration_date IS NOT DISTINCT FROM p_expiration_date
      AND package_size IS NOT DISTINCT FROM p_package_size
      AND package_label IS NOT DISTINCT FROM v_package_label
      AND (v_notes IS NULL OR notes = v_notes)
    ORDER BY created_at, id
    LIMIT 1
    FOR UPDATE;

    v_lot_merged := v_lot_id IS NOT NULL;
    IF v_lot_merged THEN
        UPDATE public.lots
        SET quantity = quantity + p_quantity,
            initial_quantity = initial_quantity + p_quantity,
            is_estimate = is_estimate OR coalesce(p_is_estimate, false)
        WHERE id = v_lot_id AND household_id = p_household_id;
    ELSE
        INSERT INTO public.lots(food_id, household_id, quantity, initial_quantity,
            package_size, package_label, is_estimate, expiration_date, storage_location,
            added_by, notes)
        VALUES (v_food_id, p_household_id, p_quantity, p_quantity, p_package_size,
            v_package_label, coalesce(p_is_estimate, false), p_expiration_date,
            p_storage_location, v_user_id, v_notes)
        RETURNING id INTO v_lot_id;
    END IF;

    RETURN jsonb_build_object('food_id', v_food_id, 'lot_id', v_lot_id,
        'food_created', v_food_created, 'lot_merged', v_lot_merged);
END;
$$;

-- Supabase grants ALL on new public objects to anon and authenticated by
-- default, so access is revoked first and then granted column by column.
REVOKE ALL ON public.food_profiles, public.foods, public.food_units, public.lots,
    public.food_stock FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.food_name_key(TEXT), public.guard_food_stock_base(),
    public.guard_lot_food(), public.require_household_member(UUID),
    public.lock_foods(UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_lot(UUID, TEXT, public.stock_base, NUMERIC, TEXT, DATE,
    UUID, TEXT, BOOLEAN, NUMERIC, NUMERIC, NUMERIC, TEXT, BOOLEAN, TEXT)
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.food_profiles TO authenticated;
GRANT SELECT, UPDATE (name, category_id) ON public.foods TO authenticated;
GRANT SELECT, INSERT (food_id, household_id, unit_key, base_per_unit),
    UPDATE (base_per_unit), DELETE ON public.food_units TO authenticated;
GRANT SELECT, UPDATE (expiration_date, storage_location, notes) ON public.lots
    TO authenticated;
GRANT SELECT ON public.food_stock TO authenticated;
GRANT EXECUTE ON FUNCTION public.food_name_key(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_lot(UUID, TEXT, public.stock_base, NUMERIC, TEXT, DATE,
    UUID, TEXT, BOOLEAN, NUMERIC, NUMERIC, NUMERIC, TEXT, BOOLEAN, TEXT) TO authenticated;

ALTER TABLE public.food_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.foods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.food_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view food profiles"
    ON public.food_profiles FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Household members can view foods"
    ON public.foods FOR SELECT TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can update foods"
    ON public.foods FOR UPDATE TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())))
    WITH CHECK (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can view food units"
    ON public.food_units FOR SELECT TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can insert food units"
    ON public.food_units FOR INSERT TO authenticated
    WITH CHECK (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can update food units"
    ON public.food_units FOR UPDATE TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())))
    WITH CHECK (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can delete food units"
    ON public.food_units FOR DELETE TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can view lots"
    ON public.lots FOR SELECT TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can update lots"
    ON public.lots FOR UPDATE TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())))
    WITH CHECK (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));
