-- Migration: add_cook_recipe_v2
--
-- Adds cook_recipe_v2, which deducts a cook from a food's lots in draw order,
-- and the draw function behind it. add_lot is redefined so that, like every
-- other writing RPC, it takes its per-food lock only through a sorted lock call.

-- Maps each food id to the live food it was merged into, if any, and takes the
-- per-food locks of the result in sorted order. Returns the live ids in the
-- order given. The merge chain is read before locking: following a hop under a
-- held lock would take the next food's lock out of sorted order, which can
-- deadlock with an RPC locking both foods. A merge that commits between the
-- read and the lock raises 40001, and the caller may retry. Raises 22023
-- FOOD_NOT_FOUND for an id that is not a food of p_household_id.
CREATE FUNCTION public.lock_live_foods(p_household_id UUID, p_food_ids UUID[])
RETURNS UUID[]
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_live UUID[] := ARRAY[]::UUID[];
    v_id UUID;
    v_next UUID;
    v_hops INTEGER;
BEGIN
    FOREACH v_id IN ARRAY p_food_ids LOOP
        v_hops := 0;
        LOOP
            SELECT merged_into_id INTO v_next FROM public.foods
            WHERE id = v_id AND household_id = p_household_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'FOOD_NOT_FOUND' USING ERRCODE = '22023',
                    DETAIL = format('No food %s in this household', v_id);
            END IF;
            EXIT WHEN v_next IS NULL;
            v_hops := v_hops + 1;
            IF v_hops > 8 THEN
                RAISE EXCEPTION 'Food merge chain is too long' USING ERRCODE = '55000';
            END IF;
            v_id := v_next;
        END LOOP;
        v_live := v_live || v_id;
    END LOOP;

    PERFORM public.lock_foods(v_live);

    IF EXISTS (
        SELECT 1 FROM public.foods
        WHERE id = ANY(v_live) AND merged_into_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Food was merged while locking; retry' USING ERRCODE = '40001';
    END IF;
    RETURN v_live;
END;
$$;

-- Draws p_amount, in the food's stock base, from a live food's unexpired lots
-- and returns {draws: [{lot_id, amount}], shortfall}. The caller must hold the
-- food's lock (lock_live_foods), so no lot of the food is added or changed by
-- another RPC while this runs.
--
-- Lots are drawn opened first, then soonest expiry (undated last), then oldest,
-- and each is finished before the next starts. Only the lots locked at the
-- start are drawn. A drawn lot is marked opened, and a lot drawn to zero is
-- depleted with reason used. Expired lots are skipped until someone reviews
-- them. Whatever the lots cannot cover is the shortfall. The draw never fails
-- for lack of stock.
--
-- Raises 22023 for an amount that is null, NaN, infinite or not positive, for
-- a fractional amount on a whole-units food, and FOOD_NOT_FOUND for a food
-- outside p_household_id.
CREATE FUNCTION public.draw_food(p_household_id UUID, p_food_id UUID, p_amount NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_whole_units_only BOOLEAN;
    v_lot_ids UUID[];
    v_lot_id UUID;
    v_have NUMERIC;
    v_take NUMERIC;
    v_left NUMERIC := p_amount;
    v_draws JSONB := '[]'::jsonb;
BEGIN
    -- NaN sorts above Infinity in numeric, so the upper bound rejects it too.
    IF p_amount IS NULL OR NOT (p_amount > 0 AND p_amount < 'Infinity') THEN
        RAISE EXCEPTION 'Amount must be finite and positive' USING ERRCODE = '22023';
    END IF;
    SELECT whole_units_only INTO v_whole_units_only FROM public.foods
    WHERE id = p_food_id AND household_id = p_household_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'FOOD_NOT_FOUND' USING ERRCODE = '22023',
            DETAIL = format('No food %s in this household', p_food_id);
    END IF;
    IF v_whole_units_only AND p_amount <> trunc(p_amount) THEN
        RAISE EXCEPTION 'This food is counted in whole units only' USING ERRCODE = '22023';
    END IF;

    v_lot_ids := ARRAY(
        SELECT id FROM public.lots
        WHERE food_id = p_food_id AND household_id = p_household_id
          AND depleted_at IS NULL
          AND (expiration_date IS NULL OR expiration_date >= current_date)
        ORDER BY opened_at IS NULL, expiration_date NULLS LAST, created_at, id
        FOR UPDATE);

    FOREACH v_lot_id IN ARRAY v_lot_ids LOOP
        EXIT WHEN v_left = 0;
        SELECT quantity INTO v_have FROM public.lots WHERE id = v_lot_id;
        v_take := least(v_have, v_left);
        UPDATE public.lots
        SET quantity = quantity - v_take,
            opened_at = coalesce(opened_at, now()),
            depleted_at = CASE WHEN v_take = v_have THEN now() END,
            depleted_reason = CASE WHEN v_take = v_have THEN 'used' END
        WHERE id = v_lot_id;
        v_draws := v_draws || jsonb_build_object('lot_id', v_lot_id, 'amount', v_take);
        v_left := v_left - v_take;
    END LOOP;

    RETURN jsonb_build_object('draws', v_draws, 'shortfall', v_left);
END;
$$;

CREATE FUNCTION public.cook_recipe_v2(
    p_household_id UUID,
    p_operation_id UUID,
    p_recipe_id UUID,
    p_recipe_snapshot JSONB,
    p_deductions JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := public.require_household_member(p_household_id);
    v_existing public.cook_events;
    v_line JSONB;
    v_requested UUID[] := ARRAY[]::UUID[];
    v_amounts NUMERIC[] := ARRAY[]::NUMERIC[];
    v_food_ids UUID[] := ARRAY[]::UUID[];
    v_food_id UUID;
    v_draw JSONB;
    v_result JSONB := '[]'::jsonb;
    v_event_id UUID;
BEGIN
    IF p_operation_id IS NULL OR p_recipe_id IS NULL
        OR jsonb_typeof(p_deductions) IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_recipe_snapshot) IS DISTINCT FROM 'object'
        OR p_recipe_snapshot->>'recipe_id' IS DISTINCT FROM p_recipe_id::text THEN
        RAISE EXCEPTION 'Invalid cook request' USING ERRCODE = '22023';
    END IF;

    -- Serializes requests that share an operation id, so a retried request
    -- finds the first one's event instead of deducting again. The key matches
    -- cook_recipe's, so the two functions never both apply one operation.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_household_id::text || ':' || p_operation_id::text, 0));

    SELECT * INTO v_existing FROM public.cook_events
    WHERE household_id = p_household_id AND operation_id = p_operation_id;
    IF FOUND THEN
        IF v_existing.user_id <> v_user_id OR v_existing.recipe_id <> p_recipe_id
            OR v_existing.recipe_snapshot IS DISTINCT FROM p_recipe_snapshot
            OR v_existing.request_deductions IS DISTINCT FROM p_deductions THEN
            RAISE EXCEPTION 'Operation id was already used with a different payload'
                USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_build_object('cook_event_id', v_existing.id,
            'operation_id', v_existing.operation_id, 'deductions', v_existing.deductions);
    END IF;

    FOR v_line IN SELECT value FROM jsonb_array_elements(p_deductions) LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object'
            OR NOT v_line ? 'inventory_item_id' OR NOT v_line ? 'confirmed_amount' THEN
            RAISE EXCEPTION 'Invalid deduction line' USING ERRCODE = '22023';
        END IF;
        v_requested := v_requested || (v_line->>'inventory_item_id')::UUID;
        v_amounts := v_amounts || (v_line->>'confirmed_amount')::NUMERIC;
        -- Recipes saved before foods existed name a lot. Its food stands in.
        SELECT coalesce(
            (SELECT f.id FROM public.foods f
             WHERE f.id = (v_line->>'inventory_item_id')::UUID
               AND f.household_id = p_household_id),
            (SELECT l.food_id FROM public.lots l
             WHERE l.id = (v_line->>'inventory_item_id')::UUID
               AND l.household_id = p_household_id))
        INTO v_food_id;
        IF v_food_id IS NULL THEN
            RAISE EXCEPTION 'FOOD_NOT_FOUND' USING ERRCODE = '22023',
                DETAIL = format('No food or lot %s in this household',
                    v_line->>'inventory_item_id');
        END IF;
        v_food_ids := v_food_ids || v_food_id;
    END LOOP;

    -- All food locks are taken in one sorted call before any draw, so two
    -- cooks sharing foods wait for each other instead of deadlocking.
    v_food_ids := public.lock_live_foods(p_household_id, v_food_ids);
    -- The cook planner sums every line of a food into one amount, so two lines
    -- reaching one food (a food and its own lot, or two merged foods) are a
    -- client bug, not two draws.
    IF (SELECT count(DISTINCT id) FROM unnest(v_food_ids) id) <> cardinality(v_food_ids) THEN
        RAISE EXCEPTION 'DUPLICATE_FOOD' USING ERRCODE = '22023',
            DETAIL = 'Each food may appear in one deduction line only';
    END IF;

    FOR i IN 1 .. cardinality(v_requested) LOOP
        v_draw := public.draw_food(p_household_id, v_food_ids[i], v_amounts[i]);
        v_result := v_result || jsonb_build_object(
            'inventory_item_id', v_requested[i],
            'food_id', v_food_ids[i],
            'confirmed_amount', v_amounts[i],
            'committed_amount', v_amounts[i] - (v_draw->>'shortfall')::NUMERIC,
            'draws', v_draw->'draws');
    END LOOP;

    INSERT INTO public.cook_events(household_id, user_id, recipe_id, operation_id,
        recipe_snapshot, deductions, request_deductions)
    VALUES (p_household_id, v_user_id, p_recipe_id, p_operation_id,
        p_recipe_snapshot, v_result, p_deductions)
    RETURNING id INTO v_event_id;
    RETURN jsonb_build_object('cook_event_id', v_event_id,
        'operation_id', p_operation_id, 'deductions', v_result);
END;
$$;

COMMENT ON FUNCTION public.cook_recipe_v2(UUID, UUID, UUID, JSONB, JSONB) IS
$$Deducts a confirmed cook from a household's lots and records the cook event.

p_household_id: the caller's household. p_operation_id: the id the app made
when the cook started; a repeat with the same payload returns the first
result and deducts nothing. p_recipe_id and p_recipe_snapshot: the recipe, whose
snapshot must carry the same recipe_id. p_deductions: an array of
{inventory_item_id, confirmed_amount}, where inventory_item_id is a food id, or
a lot id from a recipe saved before foods existed, and confirmed_amount is in
the food's stock base.

Each amount is drawn from the food's unexpired lots, opened first, then
soonest expiry, then oldest, following food merges. Returns {cook_event_id,
operation_id, deductions}, one deduction per line with food_id,
confirmed_amount, committed_amount (what stock covered) and draws
[{lot_id, amount}]. A shortfall is recorded, not refused.

All or nothing. Errors: 28000 when signed out; 42501 when the caller is not a
member of the household; 22023 for a malformed request, an amount
that is null, NaN, infinite or not positive, a fractional amount on a
whole-units food, an operation id reused with a different payload,
DUPLICATE_FOOD when two lines reach the same live food, and FOOD_NOT_FOUND for
an id that is not a food or lot of the household; 40001 when
a food is merged mid-request (retry).

SECURITY DEFINER, because members have no direct UPDATE of lot quantities.
Callable by authenticated household members.$$;

CREATE OR REPLACE FUNCTION public.add_lot(
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

    v_food_id := (public.lock_live_foods(p_household_id, ARRAY[v_food_id]))[1];
    -- FOR SHARE makes the stock base check below wait for, and see, any
    -- uncommitted change to the food row.
    SELECT * INTO v_food FROM public.foods
    WHERE id = v_food_id AND household_id = p_household_id
    FOR SHARE;

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

COMMENT ON FUNCTION public.add_lot(UUID, TEXT, public.stock_base, NUMERIC, TEXT, DATE,
    UUID, TEXT, BOOLEAN, NUMERIC, NUMERIC, NUMERIC, TEXT, BOOLEAN, TEXT) IS
$$Adds a batch of food for a household member and returns {food_id, lot_id, food_created, lot_merged}.

Finds the food by normalized name, creating it if new, follows merges to the
live food and unarchives it. p_quantity is in the food's stock base; backend
code does unit conversion. The amount merges into a full, unopened live lot
with the same date, location, package and note, otherwise it starts a new lot.
Food attributes (category, each_label, whole_units_only, sizes) apply only when
the food is created.

Errors: 28000 when signed out; 42501 when the caller is not a member of the
household; 22023 for an amount that is null, NaN, infinite or not positive, a
name that is empty or over 80 characters, an each_label given without stock
base each or missing with it, whole units on a weighed food, and
STOCK_BASE_MISMATCH when the food is stored in another base; 23514 for a
fractional amount on a whole-units food; 40001 when the food is renamed or
merged mid-request (retry).

SECURITY DEFINER, because members have no direct INSERT on foods or lots.
Callable by authenticated household members.$$;

REVOKE ALL ON FUNCTION public.lock_live_foods(UUID, UUID[]),
    public.draw_food(UUID, UUID, NUMERIC),
    public.cook_recipe_v2(UUID, UUID, UUID, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cook_recipe_v2(UUID, UUID, UUID, JSONB, JSONB)
    TO authenticated;
