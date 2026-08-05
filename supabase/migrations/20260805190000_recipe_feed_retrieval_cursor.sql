-- Tail-quality guard for recipe feed sessions (wayfinder ticket #44):
-- each generation run consumes the next window of the session's retrieved
-- grounding docs, so docs used by earlier runs never inspire later ones.
-- The cursor records how many docs the session has consumed so far.
ALTER TABLE public.recipe_feed_sessions
    ADD COLUMN retrieval_cursor INTEGER NOT NULL DEFAULT 0
        CHECK (retrieval_cursor >= 0);
