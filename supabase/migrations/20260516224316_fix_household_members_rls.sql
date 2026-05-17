-- Migration: fix_household_members_rls
--
-- Fixes Postgres error 42P17 ("infinite recursion detected in policy for
-- relation household_members") by dropping any existing policies on the table
-- and installing a single non-recursive SELECT policy that scopes each user
-- to their own membership row.
--
-- A future Phase 8 (Household Sharing) migration will broaden this to allow
-- users to see other members of their own household — likely via a
-- SECURITY DEFINER helper to keep the policy non-recursive.

DO $$
DECLARE
    pol record;
BEGIN
    FOR pol IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'household_members'
    LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS %I ON public.household_members',
            pol.policyname
        );
    END LOOP;
END
$$;

ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own membership"
    ON public.household_members
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());
