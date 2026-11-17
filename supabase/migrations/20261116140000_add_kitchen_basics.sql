-- Migration: add_kitchen_basics
--
-- Adds each household's kitchen basics: seasonings and cooking staples such
-- as salt and oil that recipes may use without stocking them. Every household
-- starts with a default list, and feed sessions keep the list they were
-- generated with so later pages follow the same rules.

CREATE TABLE public.kitchen_basics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) <= 40 AND public.food_name_key(name) <> ''),
    name_key TEXT GENERATED ALWAYS AS (public.food_name_key(name)) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (household_id, name_key)
);

COMMENT ON TABLE public.kitchen_basics IS
    'One ingredient a household always has on hand, such as salt or olive oil. Recipes may use it without it being in inventory, and cooking never deducts it.';
COMMENT ON COLUMN public.kitchen_basics.name IS
    'The basic as the household wrote it, at most 40 characters. The prepare_kitchen_basic trigger trims it and collapses inner whitespace on insert.';
COMMENT ON COLUMN public.kitchen_basics.name_key IS
    'food_name_key(name), so "Salt" and " salt " are the same basic within a household.';

-- Normalizes the name and caps each household at 30 basics. The basics feed
-- the recipe prompt and its response schema, which must stay small.
CREATE FUNCTION public.prepare_kitchen_basic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.name := btrim(regexp_replace(NEW.name, '\s+', ' ', 'g'));
    -- Serializes adds per household, so two phones can't both add the 30th.
    PERFORM pg_advisory_xact_lock(hashtextextended('kitchen_basics:' || NEW.household_id, 0));
    IF (SELECT count(*) FROM public.kitchen_basics b
        WHERE b.household_id = NEW.household_id) >= 30 THEN
        RAISE EXCEPTION 'KITCHEN_BASICS_FULL' USING ERRCODE = 'check_violation',
            HINT = 'A household keeps at most 30 kitchen basics.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER prepare_kitchen_basic
    BEFORE INSERT ON public.kitchen_basics
    FOR EACH ROW EXECUTE FUNCTION public.prepare_kitchen_basic();

CREATE FUNCTION public.default_kitchen_basics()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT ARRAY['Salt', 'Black pepper', 'Neutral oil', 'Olive oil', 'Water']
$$;

COMMENT ON FUNCTION public.default_kitchen_basics() IS
    'Returns the kitchen basics every household starts with. Internal; no client role may call it.';

-- SECURITY DEFINER because authenticated users may insert a household
-- directly, and at that moment they are not yet its member, so the RLS check
-- on kitchen_basics would reject the seed rows and the household with them.
CREATE FUNCTION public.seed_kitchen_basics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.kitchen_basics (household_id, name)
    SELECT NEW.id, unnest(public.default_kitchen_basics());
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_kitchen_basics() IS
    'Gives a new household the default kitchen basics from default_kitchen_basics(). Trigger function on households; SECURITY DEFINER, and no client role may call it.';

CREATE TRIGGER seed_kitchen_basics
    AFTER INSERT ON public.households
    FOR EACH ROW EXECUTE FUNCTION public.seed_kitchen_basics();

INSERT INTO public.kitchen_basics (household_id, name)
SELECT h.id, unnest(public.default_kitchen_basics())
FROM public.households h
ON CONFLICT (household_id, name_key) DO NOTHING;

-- Supabase grants ALL on new public objects to anon and authenticated by
-- default.
REVOKE ALL ON public.kitchen_basics FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_kitchen_basics(), public.prepare_kitchen_basic(),
    public.default_kitchen_basics() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT (household_id, name), DELETE ON public.kitchen_basics TO authenticated;

ALTER TABLE public.kitchen_basics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Household members can view kitchen basics"
    ON public.kitchen_basics FOR SELECT TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can add kitchen basics"
    ON public.kitchen_basics FOR INSERT TO authenticated
    WITH CHECK (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

CREATE POLICY "Household members can remove kitchen basics"
    ON public.kitchen_basics FOR DELETE TO authenticated
    USING (household_id IN (
        SELECT hm.household_id FROM public.household_members hm
        WHERE hm.user_id = (SELECT auth.uid())));

ALTER TABLE public.recipe_feed_sessions
    ADD COLUMN kitchen_basics TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.recipe_feed_sessions.kitchen_basics IS
    'The household''s kitchen basics when the session started, minus any it also tracks as a food. Refills generate with this list.';

CREATE OR REPLACE FUNCTION public.create_recipe_feed_session(
    p_user_id UUID, p_session JSONB, p_recipes JSONB
) RETURNS SETOF public.recipe_feed_sessions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_session public.recipe_feed_sessions;
BEGIN
    IF jsonb_typeof(p_recipes) IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_recipes) > 5 THEN
        RAISE EXCEPTION 'Invalid recipe feed candidates' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.recipe_feed_sessions (
        id, user_id, inventory, preferences, usable_items, retrieved_recipes,
        retrieval_cursor, exclude_titles, kitchen_basics, candidate_count,
        generation_runs, has_more
    ) VALUES (
        (p_session->>'id')::uuid, p_user_id,
        p_session->'inventory', p_session->'preferences',
        p_session->'usable_items', p_session->'retrieved_recipes',
        (p_session->>'retrieval_cursor')::integer,
        ARRAY(SELECT jsonb_array_elements_text(p_session->'exclude_titles')),
        ARRAY(SELECT jsonb_array_elements_text(
            coalesce(p_session->'kitchen_basics', '[]'::jsonb))),
        jsonb_array_length(p_recipes), 1,
        jsonb_array_length(p_recipes) > 0
            AND jsonb_array_length(p_session->'usable_items') > 0
    ) RETURNING * INTO v_session;

    INSERT INTO public.recipe_feed_items (id, user_id, session_id, position, recipe)
    SELECT (recipe->>'recipe_id')::uuid, p_user_id, v_session.id,
        (ordinality - 1)::integer, recipe
    FROM jsonb_array_elements(p_recipes) WITH ORDINALITY AS candidates(recipe, ordinality);
    RETURN NEXT v_session;
END;
$$;

COMMENT ON FUNCTION public.create_recipe_feed_session(UUID, JSONB, JSONB) IS
    'Stores a new recipe feed session for p_user_id with its first candidates, in one transaction.

p_session holds the session''s id, inventory, preferences, usable_items, retrieved_recipes, retrieval_cursor, exclude_titles and kitchen_basics; a missing kitchen_basics stores an empty list. p_recipes is a JSON array of at most 5 recipe suggestions, each with a recipe_id. Returns the stored session row. Raises 22023 when p_recipes is not an array or holds more than 5. SECURITY INVOKER; only the backend''s service role may execute it.';
