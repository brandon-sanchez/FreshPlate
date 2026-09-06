-- Corpus ingestion is a local operator action. Runtime clients retain read-only
-- access, while the trusted Supabase service role can merge recipe rows.
GRANT SELECT, INSERT, UPDATE ON public.recipe_embeddings TO service_role;
