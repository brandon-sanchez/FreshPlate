-- Migration: add_household_to_signup
--
-- handle_new_user() currently inserts only a profile row. New users have no
-- household_members row, so the mobile auth store's loadHouseholdId() returns
-- null, signs them back out, and they bounce to login forever. This migration
-- extends the trigger to also create a default household + an 'owner'
-- membership, and backfills existing users who are missing them.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  new_household_id uuid;
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', 'User'),
    NEW.raw_user_meta_data->>'avatar_url'
  );

  INSERT INTO public.households (created_by)
  VALUES (NEW.id)
  RETURNING id INTO new_household_id;

  INSERT INTO public.household_members (household_id, user_id, role)
  VALUES (new_household_id, NEW.id, 'owner');

  RETURN NEW;
END;
$function$;

-- Backfill: every existing auth.users row that has no household_members row
-- gets a new household + owner membership.
WITH missing AS (
  SELECT u.id AS user_id
  FROM auth.users u
  LEFT JOIN public.household_members hm ON hm.user_id = u.id
  WHERE hm.user_id IS NULL
), new_households AS (
  INSERT INTO public.households (created_by)
  SELECT user_id FROM missing
  RETURNING id, created_by
)
INSERT INTO public.household_members (household_id, user_id, role)
SELECT id, created_by, 'owner'
FROM new_households;
