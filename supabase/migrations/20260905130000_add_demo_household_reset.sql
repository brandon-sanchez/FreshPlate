CREATE OR REPLACE FUNCTION public.reset_demo_household(
    p_household_id uuid,
    p_user_id uuid,
    p_items jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    inserted_count integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.households
        WHERE id = p_household_id AND created_by = p_user_id
    ) OR NOT EXISTS (
        SELECT 1 FROM public.household_members
        WHERE household_id = p_household_id AND user_id = p_user_id AND role = 'owner'
    ) THEN
        RAISE EXCEPTION 'demo household and owner do not match';
    END IF;

    IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 15 AND 25 THEN
        RAISE EXCEPTION 'demo seed must contain 15 to 25 items';
    END IF;

    DELETE FROM public.inventory_items WHERE household_id = p_household_id;
    INSERT INTO public.inventory_items (
        household_id, added_by, name, quantity, unit, category_id,
        expiration_date, storage_location, notes
    )
    SELECT p_household_id, p_user_id, item->>'name', (item->>'quantity')::numeric,
           item->>'unit', fc.id, CURRENT_DATE + (item->>'expiration_days')::integer,
           item->>'storage_location', COALESCE(item->>'notes', '')
    FROM jsonb_array_elements(p_items) AS item
    JOIN public.food_categories fc ON fc.name = item->>'category';

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count <> jsonb_array_length(p_items) THEN
        RAISE EXCEPTION 'demo seed contains an unknown category';
    END IF;
    RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_demo_household(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_demo_household(uuid, uuid, jsonb) TO service_role;
