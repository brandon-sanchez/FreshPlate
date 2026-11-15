-- Migration: add_set_lot_remaining
--
-- Lets household members set how much of a batch is left, as a fraction of its
-- full size (Full, 3/4, 1/2, 1/4) or as an exact amount, without overwriting a
-- change another phone made since the batch was last read.

CREATE FUNCTION public.set_lot_remaining(
    p_household_id UUID,
    p_lot_id UUID,
    p_seen_updated_at TIMESTAMPTZ,
    p_fraction NUMERIC DEFAULT NULL,
    p_quantity NUMERIC DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_lot public.lots;
    v_quantity NUMERIC;
BEGIN
    PERFORM public.require_household_member(p_household_id);
    IF (p_fraction IS NULL) = (p_quantity IS NULL) THEN
        RAISE EXCEPTION 'Give either a fraction or a quantity' USING ERRCODE = '22023';
    END IF;
    -- NaN sorts above every number, so these bounds also refuse NaN.
    IF coalesce(p_fraction > 0 AND p_fraction <= 1,
                p_quantity > 0 AND p_quantity < 'Infinity') IS NOT TRUE THEN
        RAISE EXCEPTION 'Fraction must be in (0, 1]; quantity must be finite and positive'
            USING ERRCODE = '22023';
    END IF;
    IF p_seen_updated_at IS NULL THEN
        RAISE EXCEPTION 'The lot''s last seen updated_at is required' USING ERRCODE = '22023';
    END IF;
    PERFORM public.lock_household_lots(p_household_id, ARRAY[p_lot_id]);

    -- Read under the food lock, so a cook holding it has committed by now and
    -- its change shows up in updated_at.
    SELECT * INTO v_lot FROM public.lots
    WHERE id = p_lot_id AND household_id = p_household_id AND depleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'LOT_NOT_LIVE' USING ERRCODE = '55000';
    END IF;
    IF v_lot.updated_at <> p_seen_updated_at THEN
        RAISE EXCEPTION 'STALE' USING ERRCODE = '55000';
    END IF;
    -- Lots backfilled from inventory_items have no full size, and a fraction
    -- of an unknown amount would invent stock.
    IF p_fraction IS NOT NULL AND v_lot.initial_quantity IS NULL THEN
        RAISE EXCEPTION 'FULL_SIZE_UNKNOWN' USING ERRCODE = '55000';
    END IF;

    v_quantity := coalesce(p_quantity, p_fraction * v_lot.initial_quantity);

    -- More than the full size means the batch was topped up, so the full size
    -- grows with it and later fractions measure the bigger batch. A batch
    -- below its full size has been opened, so it comes first in draw order.
    UPDATE public.lots
    SET quantity = v_quantity,
        -- greatest() skips NULL, so the guard keeps an unknown full size unknown.
        initial_quantity = CASE WHEN initial_quantity IS NOT NULL
            THEN greatest(initial_quantity, v_quantity) END,
        is_estimate = coalesce(p_fraction < 1, false),
        opened_at = CASE WHEN v_quantity < initial_quantity
            THEN coalesce(opened_at, now()) ELSE opened_at END
    WHERE id = v_lot.id;
END;
$$;

COMMENT ON FUNCTION public.set_lot_remaining(UUID, UUID, TIMESTAMPTZ, NUMERIC, NUMERIC) IS
$$Sets how much of a live lot is left, refusing if the lot changed since the caller read it.

p_household_id: the caller's household. p_lot_id: the lot. p_seen_updated_at:
the lot's updated_at as the caller last read it, passed back unchanged at full
precision. Give exactly one of p_fraction, a share of the lot's full size
(initial_quantity) in (0, 1], or p_quantity, an exact amount in the food's
stock base. A fraction below 1 marks the amount as an estimate. A fraction of 1
or an exact amount clears the estimate. An exact amount above the full size
raises the full size to it. An amount below the full size marks the lot opened.

Errors: 28000 when signed out; 42501 when the caller is not a member of the
household; 22023 for a missing or out-of-range fraction or quantity, both
given, or a null p_lot_id or p_seen_updated_at; 55000 LOT_NOT_LIVE when the
lot is not a live lot of the household; 55000 STALE when the lot's updated_at
differs from p_seen_updated_at; 55000 FULL_SIZE_UNKNOWN for a fraction on a lot
with no full size; 23514 when the amount is fractional on a whole-units-only
food.

SECURITY DEFINER, because members have no direct UPDATE of lot quantities.
Callable by authenticated household members.$$;

REVOKE ALL ON FUNCTION public.set_lot_remaining(UUID, UUID, TIMESTAMPTZ, NUMERIC, NUMERIC)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lot_remaining(UUID, UUID, TIMESTAMPTZ, NUMERIC, NUMERIC)
    TO authenticated;
