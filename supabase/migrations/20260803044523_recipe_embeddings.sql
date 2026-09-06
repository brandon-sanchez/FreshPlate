-- RAG recipe corpus storage for the Gemini 768-dimensional embeddings.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE public.recipe_embeddings (
    id BIGINT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding extensions.vector(768) NOT NULL
);

CREATE INDEX recipe_embeddings_embedding_hnsw_idx
    ON public.recipe_embeddings
    USING hnsw (embedding extensions.vector_cosine_ops);

-- The corpus is non-user data and is read through the backend's anon-key RPC.
-- Keep the table protected by RLS while exposing only SELECT to API roles.
ALTER TABLE public.recipe_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Recipe corpus is readable by API roles"
    ON public.recipe_embeddings
    FOR SELECT
    TO anon, authenticated
    USING (true);

GRANT SELECT ON public.recipe_embeddings TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.match_recipe_embeddings(
    query_embedding extensions.vector(768),
    match_threshold DOUBLE PRECISION,
    match_count INTEGER
)
RETURNS TABLE (
    id BIGINT,
    title TEXT,
    content TEXT,
    similarity DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
    IF query_embedding IS NULL THEN
        RAISE EXCEPTION 'query_embedding must not be null'
            USING ERRCODE = '22023';
    END IF;

    IF match_threshold IS NULL OR match_threshold < -1 OR match_threshold > 1 THEN
        RAISE EXCEPTION 'match_threshold must be between -1 and 1'
            USING ERRCODE = '22023';
    END IF;

    IF match_count IS NULL OR match_count < 1 OR match_count > 200 THEN
        RAISE EXCEPTION 'match_count must be between 1 and 200'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        recipes.id,
        recipes.title,
        recipes.content,
        (1 - (recipes.embedding <=> query_embedding))::DOUBLE PRECISION AS similarity
    FROM public.recipe_embeddings AS recipes
    WHERE recipes.embedding <=> query_embedding <= 1 - match_threshold
    ORDER BY recipes.embedding <=> query_embedding ASC
    LIMIT match_count;
END;
$$;

REVOKE ALL ON FUNCTION public.match_recipe_embeddings(
    extensions.vector,
    DOUBLE PRECISION,
    INTEGER
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.match_recipe_embeddings(
    extensions.vector,
    DOUBLE PRECISION,
    INTEGER
) TO anon, authenticated;
