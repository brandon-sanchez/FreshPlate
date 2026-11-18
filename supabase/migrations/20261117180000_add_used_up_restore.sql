-- Migration: add_used_up_restore
--
-- Lists foods that ran out in the last 14 days and lets a household member
-- bring one back with the amount actually left, so a cook or a "Used up" swipe
-- that emptied a food by mistake is fixable.

-- security_invoker applies the caller's row-level security on foods and lots,
-- so members see only their own households.
CREATE VIEW public.recently_used_up WITH (security_invoker = true) AS
SELECT DISTINCT ON (l.food_id)
    l.id AS lot_id,
    l.food_id,
    l.household_id,
    f.name,
    f.stock_base,
    f.each_label,
    f.whole_units_only,
    l.depleted_at
FROM public.lots l
JOIN public.foods f ON f.id = l.food_id
WHERE l.depleted_reason = 'used'
  AND l.depleted_at >= now() - interval '14 days'
  AND f.archived_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.lots live
      WHERE live.food_id = l.food_id AND live.depleted_at IS NULL)
ORDER BY l.food_id, l.depleted_at DESC, l.id;

COMMENT ON VIEW public.recently_used_up IS
$$Foods a household used up in the last 14 days and has no stock of, one row per food.

lot_id is the food's most recently used-up batch, which restore_used_up_lot
brings back. Amounts are in stock_base, a count of each_label for 'each'.
Tossed batches are left out; their undo goes through restore_lots.$$;

CREATE FUNCTION public.restore_used_up_lot(
    p_household_id UUID,
    p_lot_id UUID,
    p_quantity NUMERIC
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_food_id UUID;
BEGIN
    PERFORM public.require_household_member(p_household_id);
    -- NaN sorts above Infinity in numeric, so the upper bound rejects it too.
    IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity') THEN
        RAISE EXCEPTION 'Quantity must be finite and positive' USING ERRCODE = '22023';
    END IF;
    PERFORM public.lock_household_lots(p_household_id, ARRAY[p_lot_id]);

    -- Only the batch the view offers is restorable, checked under the food
    -- lock so a batch added on another phone a moment ago refuses the restore.
    -- Filtering on food_id, the view's DISTINCT ON key, keeps the scan to one food.
    SELECT food_id INTO v_food_id FROM public.lots
    WHERE id = p_lot_id AND household_id = p_household_id;
    IF NOT EXISTS (
        SELECT 1 FROM public.recently_used_up
        WHERE food_id = v_food_id AND lot_id = p_lot_id
    ) THEN
        RAISE EXCEPTION 'LOT_NOT_RESTORABLE' USING ERRCODE = '55000';
    END IF;

    UPDATE public.lots
    SET quantity = p_quantity,
        -- greatest() skips NULL, so the guard keeps an unknown full size unknown.
        initial_quantity = CASE WHEN initial_quantity IS NOT NULL
            THEN greatest(initial_quantity, p_quantity) END,
        is_estimate = false,
        opened_at = CASE WHEN p_quantity < initial_quantity
            THEN coalesce(opened_at, now()) ELSE opened_at END,
        depleted_at = NULL,
        depleted_reason = NULL
    WHERE id = p_lot_id;
END;
$$;

COMMENT ON FUNCTION public.restore_used_up_lot(UUID, UUID, NUMERIC) IS
$$Returns a food's recently used-up batch to live stock with the amount the caller says is left.

p_household_id: the caller's household. p_lot_id: a recently_used_up.lot_id
of that household. p_quantity: the amount left, in the food's stock base.
The amount clears the estimate flag and raises the batch's full size when it is
larger. An amount below the full size marks the batch opened.

Errors: 28000 when signed out; 42501 when the caller is not a member of the
household; 22023 for a null, NaN, infinite or non-positive quantity, or a null
p_lot_id; 55000 LOT_NOT_RESTORABLE when the lot is not a recently_used_up.lot_id
of the household, including live, tossed and already restored batches, older
batches of the food, and batches of a food that has stock again; 23514 when
the amount is fractional on a whole-units-only food.

SECURITY DEFINER, because members have no direct UPDATE of lot quantities.
Callable by authenticated household members.$$;

REVOKE ALL ON public.recently_used_up FROM anon, authenticated;
GRANT SELECT ON public.recently_used_up TO authenticated;
REVOKE ALL ON FUNCTION public.restore_used_up_lot(UUID, UUID, NUMERIC)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_used_up_lot(UUID, UUID, NUMERIC) TO authenticated;
