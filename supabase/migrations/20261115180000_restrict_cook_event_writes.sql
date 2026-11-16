-- Makes cook_recipe_v2 the only writer of cook_events. A member could
-- otherwise insert a cook with any snapshot, deductions or lines without
-- taking anything from stock, and Cook Again reads these rows as history.

DROP POLICY "Household members can insert cook events" ON public.cook_events;

-- Supabase grants ALL on public tables to anon and authenticated, so every
-- privilege is revoked before SELECT is given back. SELECT is safe to give
-- back because its RLS policy limits members to their own households' rows.
-- cook_recipe_v2 is SECURITY DEFINER and writes as the table owner, so these
-- grants do not limit it.
REVOKE ALL ON public.cook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cook_events TO authenticated;

-- cook_recipe is SECURITY INVOKER and inserts as the caller, so without the
-- INSERT grant every call fails. No client needs it, because
-- POST /api/cook/confirm calls cook_recipe_v2.
REVOKE EXECUTE ON FUNCTION public.cook_recipe(UUID, UUID, UUID, JSONB, JSONB)
    FROM authenticated;

COMMENT ON TABLE public.cook_events IS
$$One confirmed cook of a recipe by a household member, with the recipe snapshot and what the cook took from stock.

Members write rows only through cook_recipe_v2.$$;
