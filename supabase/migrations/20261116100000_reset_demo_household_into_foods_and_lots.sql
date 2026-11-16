-- Migration: reset_demo_household_into_foods_and_lots
--
-- Makes the demo reset seed foods, food_units and lots, which the app reads,
-- instead of inventory_items. The reset also clears the household's
-- inventory_items rows, so a later run of the inventory move has nothing to
-- add back next to the seeded lots, and its cook_events, which would name
-- deleted foods and lots.

DROP FUNCTION public.reset_demo_household(uuid, uuid, jsonb);

CREATE FUNCTION public.reset_demo_household(
    p_household_id uuid,
    p_user_id uuid,
    p_foods jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_food jsonb;
    v_food_id uuid;
BEGIN
    -- FOR UPDATE serializes two resets of the same household; without it the
    -- second one's inserts would collide with the first one's foods.
    PERFORM 1
    FROM public.demo_households d
    JOIN public.households h ON h.id = d.household_id
    WHERE d.household_id = p_household_id
      AND h.created_by = p_user_id
      AND EXISTS (
          SELECT 1 FROM public.household_members hm
          WHERE hm.household_id = p_household_id
            AND hm.user_id = p_user_id
            AND hm.role = 'owner')
    FOR UPDATE OF d;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'demo household and owner do not match' USING ERRCODE = '42501';
    END IF;

    -- The key lists match the jsonb_to_record column lists below, which
    -- silently ignore any other key, so a misspelled key fails here instead
    -- of seeding a food without the fact it was meant to carry.
    IF jsonb_typeof(p_foods) IS DISTINCT FROM 'array' OR jsonb_array_length(p_foods) = 0 THEN
        RAISE EXCEPTION 'demo seed must be a non-empty array of foods' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_foods) food
        WHERE jsonb_typeof(food) IS DISTINCT FROM 'object'
           OR food - ARRAY['name', 'category', 'stock_base', 'each_label',
               'whole_units_only', 'grams_per_each', 'units', 'lots'] <> '{}'::jsonb
           OR jsonb_typeof(coalesce(food->'units', '{}'::jsonb)) <> 'object'
           OR jsonb_typeof(food->'lots') IS DISTINCT FROM 'array'
           OR jsonb_array_length(food->'lots') = 0
           OR NOT EXISTS (
               SELECT 1 FROM public.food_categories c WHERE c.name = food->>'category')
           OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(food->'lots') lot
               WHERE jsonb_typeof(lot) IS DISTINCT FROM 'object'
                  OR lot - ARRAY['quantity', 'initial_quantity', 'expiration_days',
                      'opened_days_ago', 'storage_location', 'notes'] <> '{}'::jsonb))
    THEN
        RAISE EXCEPTION 'demo seed has a food with unknown keys, an unknown category or no lots'
            USING ERRCODE = '22023';
    END IF;

    -- These are the per-food locks every stock-changing RPC takes, so an
    -- add_lot or cook in flight on an existing food finishes first.
    PERFORM public.lock_foods(ARRAY(
        SELECT id FROM public.foods WHERE household_id = p_household_id));
    DELETE FROM public.lots WHERE household_id = p_household_id;
    -- Elsewhere foods are archived, never deleted, so cook history keeps
    -- resolving. The reset deletes that history with them, so no past demo
    -- cook names a deleted food. food_units rows go through ON DELETE CASCADE.
    DELETE FROM public.foods WHERE household_id = p_household_id;
    DELETE FROM public.cook_events WHERE household_id = p_household_id;
    DELETE FROM public.inventory_items WHERE household_id = p_household_id;

    FOR v_food IN SELECT value FROM jsonb_array_elements(p_foods) LOOP
        INSERT INTO public.foods (household_id, category_id, name, stock_base, each_label,
            whole_units_only, grams_per_each)
        SELECT p_household_id, c.id, f.name, f.stock_base, f.each_label,
            coalesce(f.whole_units_only, false), f.grams_per_each
        FROM jsonb_to_record(v_food) AS f(name text, category text,
            stock_base public.stock_base, each_label text, whole_units_only boolean,
            grams_per_each numeric)
        JOIN public.food_categories c ON c.name = f.category
        RETURNING id INTO v_food_id;

        INSERT INTO public.food_units (food_id, household_id, unit_key, base_per_unit)
        SELECT v_food_id, p_household_id, unit.key, (unit.value #>> '{}')::numeric
        FROM jsonb_each(coalesce(v_food->'units', '{}'::jsonb)) unit;

        INSERT INTO public.lots (food_id, household_id, quantity, initial_quantity,
            expiration_date, opened_at, storage_location, added_by, notes)
        SELECT v_food_id, p_household_id, l.quantity,
            coalesce(l.initial_quantity, l.quantity), current_date + l.expiration_days,
            now() - make_interval(days => l.opened_days_ago),
            l.storage_location, p_user_id, l.notes
        FROM jsonb_to_recordset(v_food->'lots') AS l(quantity numeric,
            initial_quantity numeric, expiration_days integer, opened_days_ago integer,
            storage_location text, notes text);
    END LOOP;

    RETURN jsonb_array_length(p_foods);
END;
$$;

COMMENT ON FUNCTION public.reset_demo_household(uuid, uuid, jsonb) IS
$$Replaces a demo household's inventory and cook history with a seeded kitchen and returns the number of foods.

Deletes the household's lots, foods, food_units, cook_events and
inventory_items rows, then inserts p_foods, all in the caller's
transaction. p_foods is a non-empty array of objects: {name, category (a
food_categories name), stock_base, each_label, whole_units_only (default
false), grams_per_each, units (optional): {unit word: amount in the stock
base}, lots: [{quantity, initial_quantity (defaults to quantity),
expiration_days (days from today; absent for no date), opened_days_ago
(absent for unopened), storage_location, notes}]}. p_user_id is recorded as
the user who added each lot.

Raises 42501 unless p_household_id is in demo_households and p_user_id
created it and is its owner member. Raises 22023 when p_foods is not a
non-empty array, or a food has an unknown key, an unknown category or no
lots. A value that breaks a foods or lots constraint raises that
constraint's error. Nothing changes when the reset raises.

SECURITY DEFINER; only service_role may call it.$$;

REVOKE ALL ON FUNCTION public.reset_demo_household(uuid, uuid, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_demo_household(uuid, uuid, jsonb) TO service_role;
