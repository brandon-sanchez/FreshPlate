CREATE TABLE public.saved_recipes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    recipe_id uuid NOT NULL,
    recipe jsonb NOT NULL,
    saved_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT saved_recipes_household_recipe_key UNIQUE (household_id, recipe_id),
    CONSTRAINT saved_recipes_recipe_id_matches_snapshot CHECK (
        jsonb_typeof(recipe) = 'object'
        AND recipe->>'recipe_id' IS NOT NULL
        AND (recipe->>'recipe_id')::uuid = recipe_id
    )
);

ALTER TABLE public.saved_recipes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Household members can view saved recipes" ON public.saved_recipes FOR SELECT TO authenticated USING (household_id IN (SELECT household_id FROM public.household_members WHERE user_id = auth.uid()));
CREATE POLICY "Household members can save recipes" ON public.saved_recipes FOR INSERT TO authenticated WITH CHECK (saved_by = auth.uid() AND household_id IN (SELECT household_id FROM public.household_members WHERE user_id = auth.uid()));
CREATE POLICY "Household members can remove saved recipes" ON public.saved_recipes FOR DELETE TO authenticated USING (household_id IN (SELECT household_id FROM public.household_members WHERE user_id = auth.uid()));
GRANT SELECT, INSERT, DELETE ON public.saved_recipes TO authenticated;
