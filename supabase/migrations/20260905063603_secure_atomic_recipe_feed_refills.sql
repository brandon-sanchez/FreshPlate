-- Feed generation state is writable only by the trusted backend. User JWTs
-- retain read access through the existing ownership and expiration policies.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.recipe_feed_sessions, public.recipe_feed_items
    FROM PUBLIC, anon, authenticated;
DROP POLICY "Users can create their own recipe feed sessions"
    ON public.recipe_feed_sessions;
DROP POLICY "Users can update their active recipe feed sessions"
    ON public.recipe_feed_sessions;
DROP POLICY "Users can create their own recipe feed items"
    ON public.recipe_feed_items;
DROP POLICY "Users can update their own recipe feed items"
    ON public.recipe_feed_items;
GRANT SELECT, INSERT, UPDATE
    ON public.recipe_feed_sessions, public.recipe_feed_items TO service_role;

ALTER TABLE public.recipe_feed_sessions
    ADD COLUMN refill_claim_id UUID,
    ADD COLUMN refill_claim_expires_at TIMESTAMPTZ,
    ADD COLUMN completed_refill_claim_id UUID,
    ADD CONSTRAINT recipe_feed_refill_claim_pair CHECK (
        (refill_claim_id IS NULL) = (refill_claim_expires_at IS NULL)
    );

CREATE FUNCTION public.create_recipe_feed_session(
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
        retrieval_cursor, exclude_titles, candidate_count, generation_runs, has_more
    ) VALUES (
        (p_session->>'id')::uuid, p_user_id,
        p_session->'inventory', p_session->'preferences',
        p_session->'usable_items', p_session->'retrieved_recipes',
        (p_session->>'retrieval_cursor')::integer,
        ARRAY(SELECT jsonb_array_elements_text(p_session->'exclude_titles')),
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

CREATE FUNCTION public.claim_recipe_feed_refill(
    p_user_id UUID, p_session_id UUID, p_expected_generation_runs INTEGER,
    p_claim_id UUID
) RETURNS SETOF public.recipe_feed_sessions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_session public.recipe_feed_sessions;
BEGIN
    IF p_claim_id IS NULL THEN
        RAISE EXCEPTION 'A refill claim is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_session FROM public.recipe_feed_sessions
    WHERE id = p_session_id AND user_id = p_user_id AND expires_at > now()
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    -- Active owners keep their reservation, including the sixth run. Retrying
    -- a claim never reserves another run, and stale snapshots cannot claim one.
    IF v_session.refill_claim_expires_at > now()
        OR v_session.generation_runs <> p_expected_generation_runs THEN
        RETURN NEXT v_session;
        RETURN;
    END IF;
    IF NOT v_session.has_more OR v_session.generation_runs >= 6
        OR jsonb_array_length(v_session.usable_items) = 0 THEN
        UPDATE public.recipe_feed_sessions
        SET has_more = false, refill_claim_id = NULL, refill_claim_expires_at = NULL
        WHERE id = p_session_id RETURNING * INTO v_session;
    ELSE
        -- Reserve the run before contacting the provider. A failed or abandoned
        -- request consumes its reservation. The lease outlives the API's 35s cap.
        UPDATE public.recipe_feed_sessions
        SET generation_runs = generation_runs + 1,
            refill_claim_id = p_claim_id,
            refill_claim_expires_at = now() + interval '45 seconds'
        WHERE id = p_session_id RETURNING * INTO v_session;
    END IF;
    RETURN NEXT v_session;
END;
$$;

CREATE FUNCTION public.finalize_recipe_feed_refill(
    p_user_id UUID, p_session_id UUID, p_claim_id UUID,
    p_recipes JSONB, p_exclude_titles TEXT[], p_retrieval_cursor INTEGER
) RETURNS SETOF public.recipe_feed_sessions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_session public.recipe_feed_sessions;
    v_count INTEGER;
BEGIN
    SELECT * INTO v_session FROM public.recipe_feed_sessions
    WHERE id = p_session_id AND user_id = p_user_id AND expires_at > now()
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    -- A response can be lost after commit; retrying that operation is read-only.
    IF p_claim_id IS NOT NULL AND v_session.completed_refill_claim_id = p_claim_id THEN
        RETURN NEXT v_session;
        RETURN;
    END IF;
    IF p_claim_id IS NULL OR v_session.refill_claim_id IS DISTINCT FROM p_claim_id
        OR v_session.refill_claim_expires_at <= now() THEN
        RAISE EXCEPTION 'Recipe feed refill claim is stale' USING ERRCODE = '40001';
    END IF;
    IF jsonb_typeof(p_recipes) IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_recipes) > 5
        OR p_exclude_titles IS NULL OR p_retrieval_cursor IS NULL
        OR p_retrieval_cursor < v_session.retrieval_cursor
        OR p_retrieval_cursor > jsonb_array_length(v_session.retrieved_recipes) THEN
        RAISE EXCEPTION 'Invalid recipe feed finalization' USING ERRCODE = '22023';
    END IF;
    v_count := jsonb_array_length(p_recipes);
    -- Plain inserts preserve every previously issued recipe id and position.
    -- Any failed insert rolls back the whole finalization with its metadata.
    INSERT INTO public.recipe_feed_items (id, user_id, session_id, position, recipe)
    SELECT (recipe->>'recipe_id')::uuid, p_user_id, p_session_id,
        v_session.candidate_count + (ordinality - 1)::integer, recipe
    FROM jsonb_array_elements(p_recipes) WITH ORDINALITY AS candidates(recipe, ordinality);
    UPDATE public.recipe_feed_sessions
    SET candidate_count = candidate_count + v_count,
        exclude_titles = p_exclude_titles,
        retrieval_cursor = p_retrieval_cursor,
        has_more = v_count > 0 AND generation_runs < 6,
        completed_refill_claim_id = p_claim_id,
        refill_claim_id = NULL, refill_claim_expires_at = NULL
    WHERE id = p_session_id RETURNING * INTO v_session;
    RETURN NEXT v_session;
END;
$$;

CREATE FUNCTION public.release_recipe_feed_refill(
    p_user_id UUID, p_session_id UUID, p_claim_id UUID
) RETURNS SETOF public.recipe_feed_sessions
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
    UPDATE public.recipe_feed_sessions
    SET refill_claim_id = NULL, refill_claim_expires_at = NULL,
        has_more = has_more AND generation_runs < 6
    WHERE id = p_session_id AND user_id = p_user_id
        AND refill_claim_id = p_claim_id AND expires_at > now()
    RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.create_recipe_feed_session(UUID, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_recipe_feed_refill(UUID, UUID, INTEGER, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_recipe_feed_refill(UUID, UUID, UUID, JSONB, TEXT[], INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_recipe_feed_session(UUID, JSONB, JSONB)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_recipe_feed_refill(UUID, UUID, INTEGER, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_recipe_feed_refill(UUID, UUID, UUID, JSONB, TEXT[], INTEGER)
    TO service_role;
REVOKE ALL ON FUNCTION public.release_recipe_feed_refill(UUID, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_recipe_feed_refill(UUID, UUID, UUID)
    TO service_role;
