-- Server-owned recipe feed sessions. The backend stores the analyzed inventory
-- and retrieval context once, then serves stable candidate pages while later
-- generation runs refill the same session.
CREATE TABLE public.recipe_feed_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    inventory JSONB NOT NULL DEFAULT '[]'::jsonb,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    usable_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    retrieved_recipes JSONB NOT NULL DEFAULT '[]'::jsonb,
    exclude_titles TEXT[] NOT NULL DEFAULT '{}',
    candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    generation_runs INTEGER NOT NULL DEFAULT 0 CHECK (generation_runs >= 0),
    has_more BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '2 hours')
);

CREATE INDEX recipe_feed_sessions_user_created_idx
    ON public.recipe_feed_sessions (user_id, created_at DESC);

CREATE TABLE public.recipe_feed_items (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES public.recipe_feed_sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    recipe JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, position)
);

CREATE INDEX recipe_feed_items_session_position_idx
    ON public.recipe_feed_items (session_id, position);

ALTER TABLE public.recipe_feed_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_feed_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their active recipe feed sessions"
    ON public.recipe_feed_sessions
    FOR SELECT
    TO authenticated
    USING (
        (select auth.uid()) = user_id
        AND expires_at > now()
    );

CREATE POLICY "Users can create their own recipe feed sessions"
    ON public.recipe_feed_sessions
    FOR INSERT
    TO authenticated
    WITH CHECK (
        (select auth.uid()) = user_id
        AND expires_at > now()
    );

CREATE POLICY "Users can update their active recipe feed sessions"
    ON public.recipe_feed_sessions
    FOR UPDATE
    TO authenticated
    USING (
        (select auth.uid()) = user_id
        AND expires_at > now()
    )
    WITH CHECK (
        (select auth.uid()) = user_id
        AND expires_at > now()
    );

CREATE POLICY "Users can view their own recipe feed items"
    ON public.recipe_feed_items
    FOR SELECT
    TO authenticated
    USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can create their own recipe feed items"
    ON public.recipe_feed_items
    FOR INSERT
    TO authenticated
    WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update their own recipe feed items"
    ON public.recipe_feed_items
    FOR UPDATE
    TO authenticated
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);

-- New Supabase projects may not expose public tables to the Data API by
-- default. Keep the grants explicit and let RLS provide row-level isolation.
GRANT SELECT, INSERT, UPDATE
    ON public.recipe_feed_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE
    ON public.recipe_feed_items TO authenticated;
