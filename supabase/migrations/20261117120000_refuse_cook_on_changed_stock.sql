-- Migration: refuse_cook_on_changed_stock
--
-- Makes cook_recipe_v2 refuse a cook with STOCK_CHANGED when a food has less
-- unexpired stock than the checklist expected to take, so a cook racing
-- another member's cook or toss deducts nothing instead of a partial amount.
-- A cook with no lines is accepted, so a checklist where nothing was used
-- still records the cook. A retry that differs from the recorded cook raises
-- COOK_ALREADY_CONFIRMED, so an app whose first response was lost can tell
-- the cook went through.

CREATE OR REPLACE FUNCTION public.cook_recipe_v2(
    p_household_id UUID,
    p_operation_id UUID,
    p_recipe_id UUID,
    p_recipe_snapshot JSONB,
    p_deductions JSONB,
    p_lines JSONB
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
    v_expected NUMERIC[] := ARRAY[]::NUMERIC[];
    v_changed JSONB;
    v_food_ids UUID[] := ARRAY[]::UUID[];
    v_lines JSONB[] := ARRAY[]::JSONB[];
    v_line_food_ids UUID[] := ARRAY[]::UUID[];
    v_line_draws JSONB[] := ARRAY[]::JSONB[];
    v_line_shortfalls NUMERIC[] := ARRAY[]::NUMERIC[];
    v_live UUID[];
    v_n INTEGER;
    v_position BIGINT;
    v_draw JSONB;
    v_draw_amounts NUMERIC[];
    v_draw_lots UUID[];
    v_cursor INTEGER;
    v_claims INTEGER[];
    v_left NUMERIC;
    v_share NUMERIC;
    v_take NUMERIC;
    v_taken JSONB;
    v_result JSONB := '[]'::jsonb;
    v_result_lines JSONB := '[]'::jsonb;
    v_event_id UUID;
BEGIN
    IF p_operation_id IS NULL OR p_recipe_id IS NULL
        OR jsonb_typeof(p_deductions) IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
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
            OR v_existing.request_deductions IS DISTINCT FROM p_deductions
            OR v_existing.request_lines IS DISTINCT FROM p_lines THEN
            RAISE EXCEPTION 'COOK_ALREADY_CONFIRMED' USING ERRCODE = '22023',
                DETAIL = 'Operation id was already used with a different payload';
        END IF;
        RETURN jsonb_build_object('cook_event_id', v_existing.id,
            'operation_id', v_existing.operation_id,
            'deductions', v_existing.deductions, 'lines', v_existing.lines);
    END IF;

    FOR v_line IN SELECT value FROM jsonb_array_elements(p_deductions) LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object'
            OR NOT v_line ? 'inventory_item_id' OR NOT v_line ? 'confirmed_amount'
            OR jsonb_typeof(v_line->'expected_amount') IS DISTINCT FROM 'number'
            OR (v_line->>'expected_amount')::NUMERIC < 0 THEN
            RAISE EXCEPTION 'Invalid deduction line' USING ERRCODE = '22023';
        END IF;
        v_requested := v_requested || (v_line->>'inventory_item_id')::UUID;
        v_amounts := v_amounts || (v_line->>'confirmed_amount')::NUMERIC;
        v_expected := v_expected || (v_line->>'expected_amount')::NUMERIC;
        v_food_ids := v_food_ids
            || public.food_for_item(p_household_id, (v_line->>'inventory_item_id')::UUID);
    END LOOP;

    -- JSON numbers are always finite, so requiring the number type also keeps
    -- NaN and Infinity, which only arrive as strings, out of the stored lines.
    FOR v_line, v_position IN SELECT value, ordinality
        FROM jsonb_array_elements(p_lines) WITH ORDINALITY LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object'
            OR jsonb_typeof(v_line->'inventory_item_id') IS DISTINCT FROM 'string'
            OR jsonb_typeof(v_line->'ingredient') IS DISTINCT FROM 'string'
            OR btrim(v_line->>'ingredient') = ''
            OR char_length(v_line->>'ingredient') > 200
            OR jsonb_typeof(v_line->'recipe_amount') IS DISTINCT FROM 'number'
            OR (v_line->>'recipe_amount')::NUMERIC < 0
            OR jsonb_typeof(v_line->'recipe_unit') IS DISTINCT FROM 'string'
            OR char_length(v_line->>'recipe_unit') NOT BETWEEN 1 AND 64
            OR coalesce(v_line->>'mode', '') NOT IN ('draw', 'small', 'ask')
            OR coalesce(jsonb_typeof(v_line->'stock_amount'), 'null')
                NOT IN ('number', 'null')
            OR (v_line->>'stock_amount')::NUMERIC < 0
            OR (v_line->>'mode' = 'draw' AND v_line->>'stock_amount' IS NULL)
            OR (v_line->>'mode' = 'small' AND v_line->>'stock_amount' IS NOT NULL) THEN
            RAISE EXCEPTION 'Invalid cook line' USING ERRCODE = '22023',
                DETAIL = format('Line %s', v_position);
        END IF;
        v_lines := v_lines || v_line;
        v_line_food_ids := v_line_food_ids
            || public.food_for_item(p_household_id, (v_line->>'inventory_item_id')::UUID);
    END LOOP;

    -- All food locks are taken in one sorted call before any draw, so two
    -- cooks sharing foods wait for each other instead of deadlocking. Line
    -- foods are resolved in the same call so a line records the live food.
    v_n := cardinality(v_food_ids);
    v_live := public.lock_live_foods(p_household_id, v_food_ids || v_line_food_ids);
    v_food_ids := v_live[1:v_n];
    v_line_food_ids := v_live[v_n + 1:];
    -- The cook planner sums every line of a food into one deduction, so two
    -- deductions reaching one food (a food and its own lot, or two merged
    -- foods) are a client bug, not two draws.
    IF (SELECT count(DISTINCT id) FROM unnest(v_food_ids) id) <> v_n THEN
        RAISE EXCEPTION 'DUPLICATE_FOOD' USING ERRCODE = '22023',
            DETAIL = 'Each food may appear in one deduction line only';
    END IF;

    -- Checked under the food locks and before any draw, so stock another
    -- member cooked or tossed since the checklist loaded refuses the whole
    -- cook instead of leaving it half applied. The sum matches the lots
    -- draw_food would draw from. Members may delete a lot or change its date
    -- without the food lock, so the lots are row-locked first and the sum
    -- and the draws see the same rows.
    PERFORM 1 FROM public.lots l
    WHERE l.food_id = ANY(v_food_ids) AND l.household_id = p_household_id
      AND l.depleted_at IS NULL
    FOR UPDATE;
    SELECT jsonb_agg(jsonb_build_object('food_id', t.food_id,
            'expected_amount', t.expected, 'available', s.available) ORDER BY t.n)
    INTO v_changed
    FROM unnest(v_food_ids, v_expected) WITH ORDINALITY AS t(food_id, expected, n)
    CROSS JOIN LATERAL (
        SELECT coalesce(sum(l.quantity), 0) AS available FROM public.lots l
        WHERE l.food_id = t.food_id AND l.household_id = p_household_id
          AND l.depleted_at IS NULL
          AND (l.expiration_date IS NULL OR l.expiration_date >= current_date)) s
    WHERE s.available < t.expected;
    IF v_changed IS NOT NULL THEN
        RAISE EXCEPTION 'STOCK_CHANGED' USING ERRCODE = '22023',
            DETAIL = v_changed::text;
    END IF;

    -- A line with a stock amount claims part of its food's deduction. The
    -- checks above keep small lines from having one. Every deduction needs a
    -- claiming line and every claiming line a deduction, so each drawn amount
    -- is accounted for by some ingredient.
    FOR i IN 1 .. cardinality(v_lines) LOOP
        v_line_draws := v_line_draws || '[]'::jsonb;
        v_line_shortfalls := v_line_shortfalls || 0::NUMERIC;
        IF v_lines[i]->>'stock_amount' IS NOT NULL
            AND NOT v_line_food_ids[i] = ANY(v_food_ids) THEN
            RAISE EXCEPTION 'LINES_MISMATCH' USING ERRCODE = '22023',
                DETAIL = format('Line %s draws from a food with no deduction', i);
        END IF;
    END LOOP;

    FOR i IN 1 .. v_n LOOP
        v_claims := ARRAY(
            SELECT k FROM generate_subscripts(v_lines, 1) k
            WHERE v_lines[k]->>'stock_amount' IS NOT NULL
              AND v_line_food_ids[k] = v_food_ids[i]
            ORDER BY k);
        IF cardinality(v_claims) = 0 THEN
            RAISE EXCEPTION 'LINES_MISMATCH' USING ERRCODE = '22023',
                DETAIL = format('Deduction %s has no line drawing from it', i);
        END IF;

        v_draw := public.draw_food(p_household_id, v_food_ids[i], v_amounts[i]);
        v_result := v_result || jsonb_build_object(
            'inventory_item_id', v_requested[i],
            'food_id', v_food_ids[i],
            'confirmed_amount', v_amounts[i],
            'committed_amount', v_amounts[i] - (v_draw->>'shortfall')::NUMERIC,
            'draws', v_draw->'draws');

        v_draw_lots := ARRAY(SELECT (d->>'lot_id')::UUID
            FROM jsonb_array_elements(v_draw->'draws') WITH ORDINALITY AS t(d, n) ORDER BY n);
        v_draw_amounts := ARRAY(SELECT (d->>'amount')::NUMERIC
            FROM jsonb_array_elements(v_draw->'draws') WITH ORDINALITY AS t(d, n) ORDER BY n);
        v_cursor := 1;
        v_left := v_amounts[i];
        FOR c IN 1 .. cardinality(v_claims) LOOP
            v_share := CASE WHEN c = cardinality(v_claims) THEN v_left
                ELSE least((v_lines[v_claims[c]]->>'stock_amount')::NUMERIC, v_left) END;
            v_left := v_left - v_share;
            v_taken := '[]'::jsonb;
            WHILE v_share > 0 AND v_cursor <= cardinality(v_draw_lots) LOOP
                v_take := least(v_share, v_draw_amounts[v_cursor]);
                v_taken := v_taken || jsonb_build_object(
                    'lot_id', v_draw_lots[v_cursor], 'amount', v_take);
                v_share := v_share - v_take;
                v_draw_amounts[v_cursor] := v_draw_amounts[v_cursor] - v_take;
                IF v_draw_amounts[v_cursor] = 0 THEN
                    v_cursor := v_cursor + 1;
                END IF;
            END LOOP;
            v_line_draws[v_claims[c]] := v_taken;
            v_line_shortfalls[v_claims[c]] := v_share;
        END LOOP;
    END LOOP;

    FOR i IN 1 .. cardinality(v_lines) LOOP
        v_result_lines := v_result_lines || jsonb_build_object(
            'ingredient', v_lines[i]->'ingredient',
            'inventory_item_id', v_lines[i]->'inventory_item_id',
            'food_id', v_line_food_ids[i],
            'recipe_amount', v_lines[i]->'recipe_amount',
            'recipe_unit', v_lines[i]->'recipe_unit',
            'stock_base', (SELECT stock_base FROM public.foods WHERE id = v_line_food_ids[i]),
            'stock_amount', v_lines[i]->'stock_amount',
            'mode', v_lines[i]->'mode',
            'draws', v_line_draws[i],
            'shortfall', v_line_shortfalls[i]);
    END LOOP;

    INSERT INTO public.cook_events(household_id, user_id, recipe_id, operation_id,
        recipe_snapshot, deductions, request_deductions, lines, request_lines)
    VALUES (p_household_id, v_user_id, p_recipe_id, p_operation_id,
        p_recipe_snapshot, v_result, p_deductions, v_result_lines, p_lines)
    RETURNING id INTO v_event_id;
    RETURN jsonb_build_object('cook_event_id', v_event_id,
        'operation_id', p_operation_id, 'deductions', v_result,
        'lines', v_result_lines);
END;
$$;

COMMENT ON FUNCTION public.cook_recipe_v2(UUID, UUID, UUID, JSONB, JSONB, JSONB) IS
$$Deducts a confirmed cook from a household's lots and records the cook event with one line per ingredient.

p_household_id: the caller's household. p_operation_id: the id the app made
when the cook started; a repeat with the same payload returns the first
result and deducts nothing, and a repeat with any other payload raises
COOK_ALREADY_CONFIRMED and deducts nothing. p_recipe_id and p_recipe_snapshot: the recipe, whose
snapshot must carry the same recipe_id. p_deductions: an array of
{inventory_item_id, confirmed_amount, expected_amount}, one per food, where
inventory_item_id is a food id, or a lot id from a recipe saved before foods
existed, confirmed_amount is what the cook used and expected_amount is how
much of it the checklist expected stock to cover (0 or more), both in the
food's stock base. p_lines: one entry per recipe ingredient
matched to a food the cook used, in recipe order, and may be empty:
{ingredient, inventory_item_id, recipe_amount, recipe_unit, mode,
stock_amount}. mode is draw, small or ask. stock_amount is the line's
converted amount in the food's stock base; it is required for draw, must be
null for small, and is null for an ask the cook skipped.

Before drawing anything, every food must still have at least its
expected_amount of unexpired stock; otherwise the whole cook is refused with
STOCK_CHANGED. Each amount is then drawn from the food's unexpired lots,
opened first, then soonest expiry, then oldest, following food merges. The
draws are split across the food's draw and answered ask lines in recipe
order, each taking its stock_amount and the last taking the rest. Returns
{cook_event_id, operation_id, deductions, lines}: one deduction per food with
food_id, confirmed_amount, committed_amount (what stock covered) and draws
[{lot_id, amount}], and one line per ingredient with food_id, stock_base,
draws and shortfall added. A confirmed amount above the expected amount that
stock cannot cover is recorded as a shortfall, not refused.

All or nothing. Errors: 28000 when signed out; 42501 when the caller is not a
member of the household; 22P02 for an id that is not a UUID; 22023 for a
malformed request or line (ingredient up to 200 characters, recipe_unit 1 to
64), an amount that is null, NaN, infinite or not positive, a fractional
amount on a whole-units food, COOK_ALREADY_CONFIRMED when the operation id
already recorded a cook with a different payload, DUPLICATE_FOOD when two deductions reach the same live food,
LINES_MISMATCH when a deduction has no line drawing from it or a line draws
from a food with no deduction, FOOD_NOT_FOUND for an id that is not a food or
lot of the household, and STOCK_CHANGED, whose DETAIL is a JSON array of
{food_id, expected_amount, available} for each food that fell short; 40001
when a food is merged mid-request (retry).

SECURITY DEFINER, because members have no direct UPDATE of lot quantities.
Callable by authenticated household members.$$;
