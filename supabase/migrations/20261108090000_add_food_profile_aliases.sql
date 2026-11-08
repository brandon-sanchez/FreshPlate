-- Migration: add_food_profile_aliases
--
-- Links household foods to shared food profiles by name.
-- "Basmati rice" and "White rice" both use the rice profile through an alias
-- row, so the converter can turn "1 cup rice" into grams for either.
--
-- The link is derived, not stored. food_facts resolves a food's profile from
-- its current name every time it is read, so a rename or a new alias takes
-- effect without a backfill. foods.profile_key stays an explicit pin that
-- wins over the alias match. The seed migration that follows fills both
-- tables from USDA FoodData Central.

CREATE TABLE public.food_profile_aliases (
    alias_key TEXT PRIMARY KEY CHECK (alias_key = public.food_name_key(alias_key)),
    profile_key TEXT NOT NULL
        REFERENCES public.food_profiles(profile_key) ON DELETE CASCADE
);

CREATE INDEX idx_food_profile_aliases_profile ON public.food_profile_aliases(profile_key);

COMMENT ON TABLE public.food_profile_aliases IS
    'Food names (in food_name_key form) that share a food profile. Every profile '
    'key is also an alias of itself. Reference data written by the service role only.';

COMMENT ON INDEX public.idx_food_profile_aliases_profile IS
    'Finds a profile''s aliases, and serves the ON DELETE CASCADE from food_profiles.';

-- One row per household food with everything the backend unit converter needs.
-- Archived foods are included because cook history and restores read foods by
-- id. Built in the caller's security context, so foods RLS limits rows to the
-- caller's households.
CREATE VIEW public.food_facts WITH (security_invoker = true) AS
SELECT
    f.id, f.household_id, f.name, f.name_key, f.stock_base, f.each_label,
    f.grams_per_each, f.ml_per_each, f.g_per_ml, f.whole_units_only, f.archived_at,
    resolved.profile_key,
    p.g_per_ml AS profile_g_per_ml,
    p.unit_grams AS profile_unit_grams,
    p.source AS profile_source,
    coalesce(u.household_units, '{}') AS household_units
FROM public.foods f
LEFT JOIN public.food_profile_aliases a ON a.alias_key = f.name_key
CROSS JOIN LATERAL (
    SELECT coalesce(f.profile_key, a.profile_key) AS profile_key
) resolved
LEFT JOIN public.food_profiles p ON p.profile_key = resolved.profile_key
LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(fu.unit_key, fu.base_per_unit) AS household_units
    FROM public.food_units fu
    WHERE fu.food_id = f.id
) u ON true;

COMMENT ON VIEW public.food_facts IS
    'Per-food unit facts for the backend converter. Each row has the food''s own facts, '
    'its household unit words (unit_key -> amount in the stock base) and its '
    'profile''s facts. profile_key is foods.profile_key when pinned, else the alias match on '
    'the food''s name. Rows with a null profile_key are the unmatched foods that '
    'still need a profile.';

-- Supabase grants ALL on new public objects to anon and authenticated by
-- default, so access is revoked first and then granted read-only.
REVOKE ALL ON public.food_profile_aliases, public.food_facts FROM anon, authenticated;
GRANT SELECT ON public.food_profile_aliases, public.food_facts TO authenticated;

ALTER TABLE public.food_profile_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view food profile aliases"
    ON public.food_profile_aliases FOR SELECT TO authenticated
    USING (true);
