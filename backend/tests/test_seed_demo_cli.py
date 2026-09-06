from __future__ import annotations

import pytest

from app.scripts import seed_demo


def test_cli_passes_unchanged_dsn_via_environment_without_exposing_it(
    monkeypatch, capsys
):
    dsn = "postgresql://demo%40user:secret%2Fpass@localhost:5432/demo?sslmode=require"
    captured: dict[str, object] = {}

    class FakeConnection:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def execute(self, statement, params):
            captured.update(statement=statement, params=params)
            raise seed_demo.psycopg.Error("secret failure")

    def fake_connect(value):
        captured["dsn"] = value
        return FakeConnection()

    monkeypatch.setattr(seed_demo.psycopg, "connect", fake_connect)

    monkeypatch.setenv("DEMO_DATABASE_URL", dsn)
    monkeypatch.setenv("DEMO_HOUSEHOLD_ID", "00000000-0000-0000-0000-000000000001")
    monkeypatch.setenv("DEMO_USER_ID", "00000000-0000-0000-0000-000000000002")
    with pytest.raises(SystemExit, match="no database diagnostics"):
        seed_demo.main()

    assert captured["dsn"] == dsn
    assert captured["statement"] == (
        "SELECT public.reset_demo_household(%s::uuid, %s::uuid, %s::jsonb)"
    )
    assert captured["params"][0] == "00000000-0000-0000-0000-000000000001"
    output = capsys.readouterr()
    assert dsn not in output.out + output.err
    assert "secret%2Fpass" not in output.out + output.err
