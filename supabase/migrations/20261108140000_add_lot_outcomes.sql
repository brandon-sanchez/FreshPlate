-- Migration: add_lot_outcomes
--
-- Lets household members record what happened to a batch (used up or tossed)
-- and undo it, keeping the amount for waste history, and lets them delete a
-- batch outright when it was added by mistake.

-- Checks a lot id list, takes the food locks for those lots, and returns how
-- many distinct ids the list holds, so the calling RPC can tell whether its
-- UPDATE touched every lot. Refuses a null, empty or null-containing list with
-- 22023. Only lots of p_household_id pick foods to lock; callers must have
-- checked membership first.
CREATE FUNCTION public.lock_household_lots(p_household_id UUID, p_lot_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF p_lot_ids IS NULL OR cardinality(p_lot_ids) = 0
        OR EXISTS (SELECT 1 FROM unnest(p_lot_ids) id WHERE id IS NULL) THEN
        RAISE EXCEPTION 'Lot ids must be a non-empty list without nulls'
            USING ERRCODE = '22023';
    END IF;

    -- Holds the per-food locks every stock-changing RPC takes, so an add_lot
    -- merge into one of these lots runs wholly before or after the caller.
    PERFORM public.lock_foods(ARRAY(
        SELECT DISTINCT food_id FROM public.lots
        WHERE household_id = p_household_id AND id = ANY(p_lot_ids)));

    RETURN (SELECT count(DISTINCT id) FROM unnest(p_lot_ids) id);
END;
$$;

CREATE FUNCTION public.deplete_lots(
    p_household_id UUID,
    p_lot_ids UUID[],
    p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_wanted INTEGER;
    v_changed INTEGER;
BEGIN
    PERFORM public.require_household_member(p_household_id);
    -- 'corrected' is a valid depleted_reason, but it belongs to amount
    -- corrections, which record a different kind of event.
    IF p_reason IS NULL OR p_reason NOT IN ('used', 'tossed') THEN
        RAISE EXCEPTION 'Reason must be used or tossed' USING ERRCODE = '22023';
    END IF;
    v_wanted := public.lock_household_lots(p_household_id, p_lot_ids);

    -- The amount stays on the lot: a tossed amount feeds waste history, and a
    -- used-up amount is what restore_lots puts back.
    UPDATE public.lots
    SET depleted_at = now(), depleted_reason = p_reason
    WHERE household_id = p_household_id
      AND id = ANY(p_lot_ids)
      AND depleted_at IS NULL;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    -- All or nothing, so a stale list from another phone never half-applies.
    IF v_changed <> v_wanted THEN
        RAISE EXCEPTION 'LOT_NOT_LIVE' USING ERRCODE = '55000';
    END IF;
END;
$$;

CREATE FUNCTION public.restore_lots(
    p_household_id UUID,
    p_lot_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_wanted INTEGER;
    v_changed INTEGER;
BEGIN
    PERFORM public.require_household_member(p_household_id);
    v_wanted := public.lock_household_lots(p_household_id, p_lot_ids);

    -- An empty lot cannot be live (lots CHECK), so it counts as not
    -- restorable rather than surfacing as a constraint error.
    UPDATE public.lots
    SET depleted_at = NULL, depleted_reason = NULL
    WHERE household_id = p_household_id
      AND id = ANY(p_lot_ids)
      AND depleted_at >= now() - interval '14 days'
      AND quantity > 0;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    IF v_changed <> v_wanted THEN
        RAISE EXCEPTION 'LOT_NOT_RESTORABLE' USING ERRCODE = '55000';
    END IF;
END;
$$;

COMMENT ON FUNCTION public.deplete_lots(UUID, UUID[], TEXT) IS
$$Records that live lots of a household were used up or tossed, keeping their amounts.

p_household_id: the caller's household. p_lot_ids: the lots to deplete,
duplicates allowed. p_reason: 'used' or 'tossed'.

All or nothing. Errors: 28000 when signed out; 42501 when the caller is not a
member of the household; 22023 for a reason other than used or tossed, or an
empty or null-containing id list; 55000 LOT_NOT_LIVE when any id is not a live
lot of the household, including already-depleted lots.

SECURITY DEFINER, because members have no direct UPDATE of depletion columns.
Callable by authenticated household members.$$;

COMMENT ON FUNCTION public.restore_lots(UUID, UUID[]) IS
$$Returns lots depleted in the last 14 days to a household's live stock.

p_household_id: the caller's household. p_lot_ids: the lots to restore,
duplicates allowed. Each lot comes back with the amount it had when depleted.

All or nothing. Errors: 28000 when signed out; 42501 when the caller is not a
member of the household; 22023 for an empty or null-containing id list; 55000
LOT_NOT_RESTORABLE when any id is not a lot of the household that was depleted
within 14 days with an amount left, including live lots.

SECURITY DEFINER, because members have no direct UPDATE of depletion columns.
Callable by authenticated household members.$$;

REVOKE ALL ON FUNCTION public.lock_household_lots(UUID, UUID[]),
    public.deplete_lots(UUID, UUID[], TEXT),
    public.restore_lots(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deplete_lots(UUID, UUID[], TEXT),
    public.restore_lots(UUID, UUID[]) TO authenticated;

-- Deleting erases a batch with no history; it is for live batches added by
-- mistake. A depleted lot is usage or waste history, so the policy never
-- matches it. Recording what happened to food goes through deplete_lots.
GRANT DELETE ON public.lots TO authenticated;

CREATE POLICY "Household members can delete live lots"
    ON public.lots FOR DELETE TO authenticated
    USING (depleted_at IS NULL AND household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));
