"""Security and lifecycle checks for recipe backend dependencies."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings, validate_supabase_url
from app.main import create_app


def test_elevated_settings_are_redacted_but_remain_usable() -> None:
    settings = Settings(
        _env_file=None,
        supabase_secret_key="secret-test-value",
        supabase_service_role_key="legacy-test-value",
    )
    assert "secret-test-value" not in repr(settings)
    assert "legacy-test-value" not in settings.model_dump_json()
    assert settings.supabase_secret_key.get_secret_value() == "secret-test-value"
    assert settings.supabase_service_role_key.get_secret_value() == "legacy-test-value"


@pytest.mark.parametrize(
    "url",
    [
        "http://remote.supabase.co",
        "ftp://localhost",
        "https://user:password@host",
        "http://127.0.0.1.evil.test",
        "https://host/path",
        "https://host?key=secret",
    ],
)
def test_settings_reject_insecure_supabase_origins(url) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, supabase_url=url)


@pytest.mark.parametrize(
    "url",
    [
        "https://project.supabase.co",
        "http://localhost:54321",
        "http://127.0.0.1:54321",
        "http://[::1]:54321",
    ],
)
def test_settings_allow_tls_and_local_development(url) -> None:
    assert validate_supabase_url(url) == url


def test_supabase_http_client_is_shared_and_closed_on_shutdown() -> None:
    app = create_app()
    with TestClient(app) as client:
        shared = app.state.supabase_http_client
        assert not shared.is_closed
        assert client.get("/health").status_code == 200
        assert app.state.supabase_http_client is shared
    assert shared.is_closed


def test_prompt_cache_skips_repeat_disk_reads(monkeypatch, tmp_path: Path) -> None:
    from app.ai.prompts import loader

    (tmp_path / "recipes_v1.yaml").write_text(
        "name: recipes\nversion: 1\nmodel: test\nsystem: test\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(loader, "PROMPTS_DIR", tmp_path)
    first = loader.load_prompt("recipes")

    def fail_read(*args, **kwargs):
        raise AssertionError("Cached prompt must not read the disk")

    monkeypatch.setattr(Path, "read_text", fail_read)
    assert loader.load_prompt("recipes") is first
