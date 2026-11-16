-- Migration: add_food_profile_estimates
--
-- Stores language-model estimates of unit facts (grams per clove, density) on
-- the shared food profile, beside the sourced facts and never in place of them,
-- so the USDA reseed cannot overwrite an estimate and every fact says whether
-- it is an estimate. Each profile is estimated once, and every household whose
-- food resolves to that profile reuses the result.

ALTER TABLE public.food_profiles
    ADD COLUMN estimated_g_per_ml public.positive_amount,
    ADD COLUMN estimated_unit_grams JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(estimated_unit_grams) = 'object'
            AND NOT jsonb_path_exists(
                estimated_unit_grams, '$.* ? (@.type() != "number" || @ <= 0)')),
    ADD COLUMN estimated_at TIMESTAMPTZ,
    ADD COLUMN estimated_by TEXT,
    ADD CONSTRAINT food_profiles_estimate_provenance
        CHECK ((estimated_at IS NULL) = (estimated_by IS NULL)),
    ADD CONSTRAINT food_profiles_estimates_need_estimated_at
        CHECK (estimated_at IS NOT NULL
            OR (estimated_g_per_ml IS NULL AND estimated_unit_grams = '{}'));

COMMENT ON COLUMN public.food_profiles.estimated_g_per_ml IS
    'Estimated density in grams per millilitre. Used only when g_per_ml is null.';
COMMENT ON COLUMN public.food_profiles.estimated_unit_grams IS
    'Estimated grams per unit word, e.g. {"head": 40}; "each" is one whole item. '
    'A key in unit_grams wins over the same key here. Keys are unit words in normalize_unit '
    'form. To correct an estimate, write the fact into unit_grams or g_per_ml and set source '
    'to manual; household facts on foods and food_units already win over any profile fact.';
COMMENT ON COLUMN public.food_profiles.estimated_at IS
    'When a language model was asked for this profile''s missing facts. Set even when '
    'it returned none, so each profile is asked only once. Null means never asked.';
COMMENT ON COLUMN public.food_profiles.estimated_by IS
    'Model id that produced the estimates, e.g. gemini-3.6-flash. Set exactly when '
    'estimated_at is set.';

CREATE OR REPLACE VIEW public.food_facts WITH (security_invoker = true) AS
SELECT
    f.id, f.household_id, f.name, f.name_key, f.stock_base, f.each_label,
    f.grams_per_each, f.ml_per_each, f.g_per_ml, f.whole_units_only, f.archived_at,
    resolved.profile_key,
    coalesce(p.g_per_ml, p.estimated_g_per_ml) AS profile_g_per_ml,
    p.estimated_unit_grams || p.unit_grams AS profile_unit_grams,
    p.source AS profile_source,
    coalesce(u.household_units, '{}') AS household_units,
    p.estimated_at AS profile_estimated_at
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
    'profile''s facts, where a sourced profile fact wins over an estimated one. '
    'profile_key is foods.profile_key when pinned, else the alias match on the food''s '
    'name. Rows with a null profile_key are the unmatched foods that still need a profile.';
COMMENT ON COLUMN public.food_facts.profile_estimated_at IS
    'When the profile''s missing facts were estimated; null when never asked or when '
    'the food has no profile.';

CREATE FUNCTION public.save_food_profile_estimate(
    p_food_id UUID,
    p_profile_name TEXT,
    p_g_per_ml NUMERIC,
    p_unit_grams JSONB,
    p_estimated_by TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_key TEXT := public.food_name_key(p_profile_name);
    v_name_key_at_read TEXT;
    v_resolved TEXT;
    v_created BOOLEAN;
BEGIN
    SELECT ff.name_key, ff.profile_key
    INTO v_name_key_at_read, v_resolved
    FROM public.food_facts ff
    WHERE ff.id = p_food_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Food % does not exist', p_food_id USING ERRCODE = 'P0002';
    END IF;

    v_key := coalesce(
        (SELECT a.profile_key FROM public.food_profile_aliases a WHERE a.alias_key = v_key),
        v_key);

    INSERT INTO public.food_profiles (profile_key, source)
    VALUES (v_key, 'llm')
    ON CONFLICT (profile_key) DO NOTHING;
    v_created := FOUND;
    INSERT INTO public.food_profile_aliases (alias_key, profile_key)
    VALUES (v_key, v_key)
    ON CONFLICT (alias_key) DO NOTHING;

    -- The model's name for an unmatched food comes from a household-chosen
    -- name, so it may write estimates only into a profile it just created,
    -- never into one other households already resolve to.
    -- First writer wins: a concurrent call waits on the row lock, re-checks
    -- estimated_at under READ COMMITTED and updates nothing.
    IF v_created OR v_resolved = v_key THEN
        UPDATE public.food_profiles
        SET estimated_g_per_ml = p_g_per_ml,
            estimated_unit_grams = coalesce(p_unit_grams, '{}'),
            estimated_at = now(),
            estimated_by = p_estimated_by
        WHERE profile_key = v_key AND estimated_at IS NULL;
    END IF;

    IF v_resolved IS NULL AND v_name_key_at_read <> v_key THEN
        UPDATE public.foods
        SET profile_key = v_key
        WHERE id = p_food_id AND name_key = v_name_key_at_read AND profile_key IS NULL;
    END IF;

    SELECT ff.profile_key INTO v_resolved FROM public.food_facts ff WHERE ff.id = p_food_id;
    RETURN v_resolved;
END;
$$;

COMMENT ON FUNCTION public.save_food_profile_estimate(UUID, TEXT, NUMERIC, JSONB, TEXT) IS
$$Store a language-model estimate of a food's unit facts on its shared profile.

p_profile_name is the profile the facts describe: the food's resolved profile key, or
a generic food name ("peanut butter") for a food with no profile. The name is
normalized with food_name_key and followed through food_profile_aliases; a name with
no profile creates one with source 'llm'. p_g_per_ml (grams per millilitre, nullable)
and p_unit_grams (unit word -> grams) are stored in the estimated_* columns only when
the profile has never been estimated, so each profile is estimated once and the first
writer wins. They are stored only on the profile the food already resolves to, or on a
profile this call created: an unmatched food that names an existing profile is linked
to it without changing its facts. A food with no profile is then pinned to the profile when its own name
differs; a food named exactly like the profile resolves through the profile's
self-alias. The food is pinned, not aliased, because aliases are readable by every
signed-in user and a household's own food name is household data. A food renamed
since it was read is not pinned.

Returns the profile key the food resolves to after the call, or null when the food was
renamed meanwhile to a name with no profile.

Raises P0002 when the food does not exist; 23514 when a fact is not a positive number,
the name normalizes to an empty string, or p_estimated_by is null; and 23502 when
p_profile_name is null.

SECURITY INVOKER. Only the backend service role may execute it; the backend calls it
after asking Gemini for a food whose facts are missing.$$;

CREATE FUNCTION public.clear_food_profile_pin_on_rename()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF public.food_name_key(NEW.name) IS DISTINCT FROM OLD.name_key
        AND NEW.profile_key IS NOT DISTINCT FROM OLD.profile_key THEN
        NEW.profile_key := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER clear_foods_profile_pin_on_rename
    BEFORE UPDATE OF name ON public.foods
    FOR EACH ROW EXECUTE FUNCTION public.clear_food_profile_pin_on_rename();

COMMENT ON FUNCTION public.clear_food_profile_pin_on_rename() IS
$$Clear foods.profile_key when a rename changes the food's name key.

A pin describes the name it was made for, so after a rename the alias match resolves
the new name instead. An update that changes profile_key along with the name keeps the
changed pin. Trigger function on foods; clients cannot execute it.$$;

REVOKE ALL ON FUNCTION public.save_food_profile_estimate(UUID, TEXT, NUMERIC, JSONB, TEXT),
    public.clear_food_profile_pin_on_rename() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_food_profile_estimate(UUID, TEXT, NUMERIC, JSONB, TEXT)
    TO service_role;
