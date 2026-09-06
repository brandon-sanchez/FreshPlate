-- Add the durable cook confirmation record and the atomic deduction boundary.

ALTER TABLE public.inventory_items
    ADD COLUMN depleted_at TIMESTAMPTZ;

ALTER TABLE public.inventory_items
    ALTER COLUMN quantity TYPE NUMERIC USING quantity;

CREATE INDEX idx_inventory_items_household_depleted
    ON public.inventory_items(household_id, depleted_at);

CREATE TABLE public.cook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    recipe_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    cooked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    recipe_snapshot JSONB NOT NULL,
    deductions JSONB NOT NULL,
    request_deductions JSONB NOT NULL,
    UNIQUE (household_id, operation_id),
    CONSTRAINT cook_events_recipe_snapshot_id CHECK (
        recipe_snapshot->>'recipe_id' = recipe_id::text
    ),
    CONSTRAINT cook_events_deductions_array CHECK (
        jsonb_typeof(deductions) = 'array'
    )
);

CREATE INDEX idx_cook_events_household_recipe
    ON public.cook_events(household_id, recipe_id, cooked_at DESC);

ALTER TABLE public.cook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Household members can view cook events"
    ON public.cook_events FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.household_members hm
        WHERE hm.household_id = cook_events.household_id
          AND hm.user_id = auth.uid()
    ));

CREATE POLICY "Household members can insert cook events"
    ON public.cook_events FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.household_members hm
        WHERE hm.household_id = cook_events.household_id
          AND hm.user_id = auth.uid()
    ));

CREATE OR REPLACE FUNCTION public.cook_recipe(
    p_household_id UUID,
    p_operation_id UUID,
    p_recipe_id UUID,
    p_recipe_snapshot JSONB,
    p_deductions JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_existing public.cook_events;
    v_line JSONB;
    v_item public.inventory_items;
    v_confirmed NUMERIC;
    v_committed NUMERIC;
    v_result JSONB := '[]'::jsonb;
    v_seen UUID[] := ARRAY[]::UUID[];
    v_item_id UUID;
    v_before NUMERIC;
    v_after NUMERIC;
    v_locked_count INTEGER := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
    END IF;
    IF p_household_id IS NULL OR p_operation_id IS NULL OR p_recipe_id IS NULL
        OR p_recipe_snapshot IS NULL OR p_deductions IS NULL
        OR jsonb_typeof(p_deductions) IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_recipe_snapshot) IS DISTINCT FROM 'object'
        OR p_recipe_snapshot->>'recipe_id' IS DISTINCT FROM p_recipe_id::text THEN
        RAISE EXCEPTION 'Invalid cook request' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.household_members hm
        WHERE hm.household_id = p_household_id AND hm.user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'Household membership required' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_household_id::text || ':' || p_operation_id::text, 0)
    );

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

    FOR v_line IN SELECT value FROM jsonb_array_elements(p_deductions)
    LOOP
        IF jsonb_typeof(v_line) IS DISTINCT FROM 'object'
            OR v_line ? 'inventory_item_id' IS FALSE
            OR v_line ? 'confirmed_amount' IS FALSE THEN
            RAISE EXCEPTION 'Invalid deduction line' USING ERRCODE = '22023';
        END IF;
        v_item_id := (v_line->>'inventory_item_id')::UUID;
        v_confirmed := (v_line->>'confirmed_amount')::NUMERIC;
        IF v_item_id = ANY(v_seen) OR v_confirmed IS NULL
            OR v_confirmed <= 0 OR v_confirmed::text IN ('NaN', 'Infinity', '-Infinity') THEN
            RAISE EXCEPTION 'Deduction amounts must be finite and positive, with unique ids'
                USING ERRCODE = '22023';
        END IF;
        v_seen := array_append(v_seen, v_item_id);
    END LOOP;

    FOR v_item IN
        SELECT * FROM public.inventory_items
        WHERE household_id = p_household_id AND id = ANY(v_seen)
        ORDER BY id
        FOR UPDATE
    LOOP
        v_locked_count := v_locked_count + 1;
    END LOOP;
    IF v_locked_count <> cardinality(v_seen) THEN
        RAISE EXCEPTION 'Inventory item is not in this household' USING ERRCODE = '42501';
    END IF;

    FOR v_item IN
        SELECT * FROM public.inventory_items
        WHERE household_id = p_household_id AND id = ANY(v_seen)
        ORDER BY id
    LOOP
        v_item_id := v_item.id;
        SELECT (value->>'confirmed_amount')::NUMERIC INTO v_confirmed
        FROM jsonb_array_elements(p_deductions)
        WHERE (value->>'inventory_item_id')::UUID = v_item_id;
        v_before := v_item.quantity;
        v_after := GREATEST(v_before - LEAST(v_confirmed, GREATEST(v_before, 0)), 0);
        UPDATE public.inventory_items
        SET quantity = v_after
        WHERE id = v_item_id
        RETURNING quantity INTO v_after;
        v_committed := v_before - v_after;
        IF v_after = 0 THEN
            UPDATE public.inventory_items SET depleted_at = COALESCE(depleted_at, now())
            WHERE id = v_item_id;
        END IF;
        v_result := v_result || jsonb_build_array(jsonb_build_object(
            'inventory_item_id', v_item_id,
            'confirmed_amount', v_confirmed,
            'committed_amount', v_committed));
    END LOOP;

    INSERT INTO public.cook_events(household_id, user_id, recipe_id, operation_id,
        recipe_snapshot, deductions, request_deductions)
    VALUES (p_household_id, v_user_id, p_recipe_id, p_operation_id,
        p_recipe_snapshot, v_result, p_deductions)
    RETURNING id INTO v_existing.id;
    RETURN jsonb_build_object('cook_event_id', v_existing.id,
        'operation_id', p_operation_id, 'deductions', v_result);
EXCEPTION WHEN unique_violation THEN
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
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.cook_recipe(UUID, UUID, UUID, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cook_recipe(UUID, UUID, UUID, JSONB, JSONB)
    TO authenticated;
