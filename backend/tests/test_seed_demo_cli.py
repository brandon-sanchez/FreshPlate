from __future__ import annotations

import subprocess

import pytest

from app.scripts import seed_demo


def test_cli_passes_unchanged_dsn_via_environment_without_exposing_it(
    monkeypatch, capsys
):
    dsn = "postgresql://demo%40user:secret%2Fpass@localhost:5432/demo?sslmode=require"
    captured: dict[str, object] = {}

    def fake_run(args, *, env, **kwargs):
        captured.update(args=args, env=env, kwargs=kwargs)
        raise subprocess.CalledProcessError(2, args)

    monkeypatch.setenv("DEMO_DATABASE_URL", dsn)
    monkeypatch.setenv("DEMO_HOUSEHOLD_ID", "00000000-0000-0000-0000-000000000001")
    monkeypatch.setenv("DEMO_USER_ID", "00000000-0000-0000-0000-000000000002")
    monkeypatch.setattr(seed_demo.subprocess, "run", fake_run)

    with pytest.raises(SystemExit, match="no database diagnostics"):
        seed_demo.main()

    assert captured["env"]["PGDATABASE"] == dsn
    assert dsn not in captured["args"]
    assert "secret%2Fpass" not in " ".join(captured["args"])
    output = capsys.readouterr()
    assert dsn not in output.out + output.err
    assert "secret%2Fpass" not in output.out + output.err
