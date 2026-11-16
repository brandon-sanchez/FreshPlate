-- Migration: add_cut_and_combine_lots
--
-- Lets household members cut up part of a batch into its own opened batch, and
-- combine batches of one food that were physically mixed into one container,
-- either from batches already in stock or while adding food. Batches are only
-- ever combined on request.

-- A combined lot gave its amount to the lot it was poured into, so it keeps
-- no amount and is not restorable.
ALTER TABLE public.lots DROP CONSTRAINT lots_depleted_reason_check;
ALTER TABLE public.lots ADD CONSTRAINT lots_depleted_reason_check
    CHECK (depleted_reason IN ('used', 'tossed', 'corrected', 'combined'));

COMMENT ON COLUMN public.lots.depleted_reason IS
$$Why a depleted lot left live stock: 'used' (eaten or cooked), 'tossed' (thrown out; the amount stays for waste history), 'corrected' (an amount correction), or 'combined' (poured into another lot; the amount is 0). NULL while the lot is live.$$;

-- Pours an amount into a live lot that the caller has locked: the amount
-- adds up, the earlier date wins because mixed food is as old as its oldest
-- part, and the lot counts as opened from the earlier of its opened time and
-- p_opened_at. A total above the full size means the container was topped
-- up, so the full size grows with it; an unknown full size stays unknown.
CREATE FUNCTION public.pour_into_lot(
    p_lot_id UUID,
    p_quantity NUMERIC,
    p_expiration_date DATE,
    p_opened_at TIMESTAMPTZ,
    p_is_estimate BOOLEAN
) RETURNS VOID
LANGUAGE sql
SET search_path = ''
AS $$
    UPDATE public.lots
    SET quantity = quantity + p_quantity,
        initial_quantity = CASE WHEN initial_quantity IS NOT NULL
            THEN greatest(initial_quantity, quantity + p_quantity) END,
        -- least() skips NULL, so a dated part dates an undated container.
        expiration_date = least(expiration_date, p_expiration_date),
        opened_at = least(opened_at, p_opened_at),
        is_estimate = is_estimate OR p_is_estimate
    WHERE id = p_lot_id;
$$;

CREATE FUNCTION public.cut_lot(
    p_household_id UUID,
    p_lot_id UUID,
    p_quantity NUMERIC,
    p_expiration_date DATE DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := public.require_household_member(p_household_id);
    v_lot public.lots;
    v_stock_base public.stock_base;
    v_expiration_date DATE;
    v_cut_id UUID;
BEGIN
    IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity') THEN
        RAISE EXCEPTION 'Quantity must be finite and positive' USING ERRCODE = '22023';
    END IF;
    PERFORM public.lock_household_lots(p_household_id, ARRAY[p_lot_id]);

    -- Read under the food lock, so a cook that drew from this lot has
    -- committed and its amount is the one checked below.
    SELECT * INTO v_lot FROM public.lots
    WHERE id = p_lot_id AND household_id = p_household_id AND depleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'LOT_NOT_LIVE' USING ERRCODE = '55000';
    END IF;
    SELECT stock_base INTO v_stock_base FROM public.foods WHERE id = v_lot.food_id;
    IF p_quantity > v_lot.quantity THEN
        RAISE EXCEPTION 'NOT_ENOUGH_LEFT' USING ERRCODE = '55000';
    END IF;

    -- least() skips NULL, so an undated lot takes the given date and no date
    -- given keeps the lot's. Cutting only ever shortens a date.
    v_expiration_date := least(v_lot.expiration_date, p_expiration_date);

    IF p_quantity = v_lot.quantity THEN
        UPDATE public.lots
        SET opened_at = coalesce(opened_at, now()),
            expiration_date = v_expiration_date
        WHERE id = v_lot.id;
        RETURN v_lot.id;
    END IF;

    -- Taking 1 of 5 whole apples leaves 4 whole apples, still full and sealed.
    -- Pouring from a bottle or a bag by weight or volume leaves the container
    -- its size but less full, and opened, so add_lot never merges into it.
    UPDATE public.lots
    SET quantity = quantity - p_quantity,
        initial_quantity = CASE WHEN v_stock_base = 'each' AND initial_quantity = quantity
            THEN initial_quantity - p_quantity ELSE initial_quantity END,
        opened_at = CASE WHEN v_stock_base = 'each' THEN opened_at
            ELSE coalesce(opened_at, now()) END
    WHERE id = v_lot.id;

    -- The package (bag, bottle) stays with the original lot.
    INSERT INTO public.lots(food_id, household_id, quantity, initial_quantity, is_estimate,
        expiration_date, opened_at, storage_location, source_cook_event_id, added_by)
    VALUES (v_lot.food_id, p_household_id, p_quantity, p_quantity, v_lot.is_estimate,
        v_expiration_date, now(), v_lot.storage_location, v_lot.source_cook_event_id, v_user_id)
    RETURNING id INTO v_cut_id;
    RETURN v_cut_id;
END;
$$;

CREATE FUNCTION public.combine_lots(
    p_household_id UUID,
    p_into_lot_id UUID,
    p_lot_ids UUID[]
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_others UUID[];
    v_wanted INTEGER;
    v_found INTEGER;
    v_foods INTEGER;
    v_poured NUMERIC;
    v_earliest DATE;
    v_opened_at TIMESTAMPTZ;
    v_estimate BOOLEAN;
BEGIN
    PERFORM public.require_household_member(p_household_id);
    IF p_into_lot_id IS NULL OR p_lot_ids IS NULL
        OR EXISTS (SELECT 1 FROM unnest(p_lot_ids) id WHERE id IS NULL) THEN
        RAISE EXCEPTION 'Lot ids must be given without nulls' USING ERRCODE = '22023';
    END IF;
    v_others := ARRAY(SELECT DISTINCT id FROM unnest(p_lot_ids) id WHERE id <> p_into_lot_id);
    IF cardinality(v_others) = 0 THEN
        RAISE EXCEPTION 'Give at least one other lot to combine' USING ERRCODE = '22023';
    END IF;
    v_wanted := public.lock_household_lots(p_household_id, v_others || p_into_lot_id);

    SELECT count(*), count(DISTINCT food_id),
        coalesce(sum(quantity) FILTER (WHERE id <> p_into_lot_id), 0),
        min(expiration_date) FILTER (WHERE id <> p_into_lot_id),
        min(opened_at) FILTER (WHERE id <> p_into_lot_id),
        coalesce(bool_or(is_estimate) FILTER (WHERE id <> p_into_lot_id), false)
    INTO v_found, v_foods, v_poured, v_earliest, v_opened_at, v_estimate
    FROM (
        SELECT * FROM public.lots
        WHERE household_id = p_household_id
          AND id = ANY(v_others || p_into_lot_id)
          AND depleted_at IS NULL
        FOR UPDATE
    ) l;

    -- All or nothing, so a stale selection from another phone never half-applies.
    IF v_found <> v_wanted THEN
        RAISE EXCEPTION 'LOT_NOT_LIVE' USING ERRCODE = '55000';
    END IF;
    IF v_foods > 1 THEN
        RAISE EXCEPTION 'DIFFERENT_FOODS' USING ERRCODE = '22023';
    END IF;

    UPDATE public.lots
    SET quantity = 0, depleted_at = now(), depleted_reason = 'combined'
    WHERE household_id = p_household_id AND id = ANY(v_others);

    PERFORM public.pour_into_lot(p_into_lot_id, v_poured, v_earliest,
        coalesce(v_opened_at, now()), v_estimate);
    RETURN p_into_lot_id;
END;
$$;

CREATE FUNCTION public.add_to_lot(
    p_household_id UUID,
    p_lot_id UUID,
    p_stock_base public.stock_base,
    p_quantity NUMERIC,
    p_expiration_date DATE DEFAULT NULL,
    p_each_label TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_each_label TEXT := nullif(lower(btrim(p_each_label)), '');
    v_food public.foods;
BEGIN
    PERFORM public.require_household_member(p_household_id);
    IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity') THEN
        RAISE EXCEPTION 'Quantity must be finite and positive' USING ERRCODE = '22023';
    END IF;
    PERFORM public.lock_household_lots(p_household_id, ARRAY[p_lot_id]);

    SELECT f.* INTO v_food
    FROM public.lots l JOIN public.foods f ON f.id = l.food_id
    WHERE l.id = p_lot_id AND l.household_id = p_household_id AND l.depleted_at IS NULL
    FOR UPDATE OF l;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'LOT_NOT_LIVE' USING ERRCODE = '55000';
    END IF;
    -- Same message and DETAIL shape as add_lot, so clients read both alike.
    IF v_food.stock_base IS DISTINCT FROM p_stock_base
        OR v_food.each_label IS DISTINCT FROM v_each_label THEN
        RAISE EXCEPTION 'STOCK_BASE_MISMATCH'
            USING ERRCODE = '22023',
                  DETAIL = format('Food %s is stored as %s%s', v_food.id, v_food.stock_base,
                      coalesce(' (' || v_food.each_label || ')', ''));
    END IF;

    PERFORM public.pour_into_lot(p_lot_id, p_quantity, p_expiration_date, now(), false);
END;
$$;

COMMENT ON FUNCTION public.cut_lot(UUID, UUID, NUMERIC, DATE) IS
$$Splits part of a live lot into its own opened lot of the same food and returns the cut lot's id.

p_household_id: the caller's household. p_lot_id: the lot to cut from.
p_quantity: the amount to cut, in the food's stock base, at most the lot's
amount. p_expiration_date: the cut part's date; the cut lot takes the earlier
of it and the lot's date, so cutting never extends a date, and NULL keeps the
lot's date. The food's total is unchanged. The cut lot is opened, so it is
drawn first. A full lot counted in each stays full at its smaller count; a lot
in g or ml keeps its full size and is marked opened. Cutting the whole amount
opens the lot in place and returns its own id.

Errors: 28000 when signed out; 42501 when the caller is not a member of the
household; 22023 for a missing, non-positive or non-finite quantity or a null
p_lot_id; 55000 LOT_NOT_LIVE when the lot is not a live lot of the household;
55000 NOT_ENOUGH_LEFT when p_quantity is more than the lot holds; 23514 for a
fractional amount on a whole-units-only food.

SECURITY DEFINER, because members have no direct INSERT on lots or UPDATE of
lot quantities. Callable by authenticated household members.$$;

COMMENT ON FUNCTION public.combine_lots(UUID, UUID, UUID[]) IS
$$Pours live lots of one food into one of them and returns that lot's id.

p_household_id: the caller's household. p_into_lot_id: the lot that holds the
mix and keeps its location, package and notes. p_lot_ids: the lots poured in,
duplicates and p_into_lot_id allowed. The result holds the sum of the amounts,
is opened, takes the earliest date, and is an estimate when any part was. Its
full size grows to the total when the total is larger, and stays unknown when
it was unknown. The poured-in lots are depleted as 'combined' with no amount
left, so they cannot be restored.

All or nothing. Errors: 28000 when signed out; 42501 when the caller is not a
member of the household; 22023 for a null id, a list with no lot besides
p_into_lot_id, or lots of different foods (DIFFERENT_FOODS); 55000
LOT_NOT_LIVE when any id is not a live lot of the household.

SECURITY DEFINER, because members have no direct UPDATE of lot quantities.
Callable by authenticated household members.$$;

COMMENT ON FUNCTION public.add_to_lot(UUID, UUID, public.stock_base, NUMERIC, DATE, TEXT) IS
$$Adds food to an existing live lot, as when topping up a jug or filling an egg tray.

p_household_id: the caller's household. p_lot_id: the container's lot.
p_stock_base and p_each_label: the unit the amount is in, which must be the
food's stock base and count word. p_quantity: the amount added, in that unit.
p_expiration_date: the added food's date, or NULL when it has none. The lot
takes the earlier of its date and p_expiration_date, is marked opened, and its
full size grows to the new amount when that is larger.

Errors: 28000 when signed out; 42501 when the caller is not a member of the
household; 22023 for a missing, non-positive or non-finite quantity or a null
p_lot_id; 22023 STOCK_BASE_MISMATCH, with a DETAIL naming the food's stock
base, when the unit differs from the food's; 55000 LOT_NOT_LIVE when the lot is
not a live lot of the household; 23514 for a fractional amount on a
whole-units-only food.

SECURITY DEFINER, because members have no direct UPDATE of lot quantities.
Callable by authenticated household members.$$;

REVOKE ALL ON FUNCTION public.pour_into_lot(UUID, NUMERIC, DATE, TIMESTAMPTZ, BOOLEAN),
    public.cut_lot(UUID, UUID, NUMERIC, DATE),
    public.combine_lots(UUID, UUID, UUID[]),
    public.add_to_lot(UUID, UUID, public.stock_base, NUMERIC, DATE, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cut_lot(UUID, UUID, NUMERIC, DATE),
    public.combine_lots(UUID, UUID, UUID[]),
    public.add_to_lot(UUID, UUID, public.stock_base, NUMERIC, DATE, TEXT)
    TO authenticated;
