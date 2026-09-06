"""Disposable PostgreSQL acceptance tests for saved recipe identity and RLS."""
# ruff: noqa: E501

from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

import pytest

DSN = os.environ.get("FRESHPLATE_TEST_POSTGRES_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="Requires disposable local PostgreSQL")
MIGRATION = (
    Path(__file__).parents[2]
    / "supabase/migrations/20260906011345_create_saved_recipes.sql"
)
A = "00000000-0000-0000-0000-000000000001"
B = "00000000-0000-0000-0000-000000000002"


def q(sql, check=True):
    return subprocess.run(
        ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", DSN],
        input=sql,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )


@pytest.fixture(scope="module")
def db():
    global DSN
    name = "freshplate_saved_" + uuid.uuid4().hex
    assert q(f"CREATE DATABASE {name}").returncode == 0
    dsn = DSN.rsplit("/", 1)[0] + "/" + name
    old = DSN
    DSN = dsn
    try:
        setup = f"""CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE TABLE public.households(id uuid primary key); CREATE TABLE public.household_members(household_id uuid,user_id uuid);
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
INSERT INTO auth.users VALUES ('{A}'),('{B}'); INSERT INTO households VALUES ('10000000-0000-0000-0000-000000000001'),('20000000-0000-0000-0000-000000000002');
INSERT INTO household_members VALUES ('10000000-0000-0000-0000-000000000001','{A}');
CREATE EXTENSION IF NOT EXISTS pgcrypto;"""
        r = q(setup)
        assert r.returncode == 0, r.stderr
        r = q(MIGRATION.read_text())
        assert r.returncode == 0, r.stderr
        r = q(
            "GRANT SELECT ON public.household_members, public.households TO authenticated;"
        )
        assert r.returncode == 0, r.stderr
        yield
    finally:
        DSN = old
        q(f"DROP DATABASE {name} WITH (FORCE)")


def test_saved_recipe_constraints_and_rls(db):
    h = "10000000-0000-0000-0000-000000000001"
    foreign = "20000000-0000-0000-0000-000000000002"
    rid = "30000000-0000-0000-0000-000000000001"
    good = f"""SET ROLE authenticated; SET request.jwt.claim.sub='{A}';
INSERT INTO saved_recipes(household_id,recipe_id,recipe,saved_by) VALUES ('{h}','{rid}','{{"recipe_id":"{rid}","title":"Soup"}}','{A}');
SELECT count(*) FROM saved_recipes; DELETE FROM saved_recipes WHERE recipe_id='{rid}';"""
    assert q(good).stdout.strip() == "1"
    assert (
        q(
            f"SET ROLE authenticated; SET request.jwt.claim.sub='{A}'; INSERT INTO saved_recipes(household_id,recipe_id,recipe,saved_by) VALUES ('{foreign}','{rid}','{{\"recipe_id\":\"{rid}\"}}','{A}');"
        ).returncode
        != 0
    )
    assert (
        q(
            f"INSERT INTO saved_recipes(household_id,recipe_id,recipe,saved_by) VALUES ('{h}','{rid}','{{\"recipe_id\":\"{rid}\"}}','{A}'),('{h}','{rid}','{{\"recipe_id\":\"{rid}\"}}','{A}');"
        ).returncode
        != 0
    )
    for snap in (
        "'{}'",
        "'{\"recipe_id\":null}'",
        '\'{"recipe_id":"40000000-0000-0000-0000-000000000001"}\'',
    ):
        assert (
            q(
                f"INSERT INTO saved_recipes(household_id,recipe_id,recipe,saved_by) VALUES ('{h}','{rid}',{snap},'{A}');"
            ).returncode
            != 0
        )
