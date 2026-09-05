from ipaddress import ip_address
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def validate_supabase_url(value: str) -> str:
    """Require TLS for remote credentials; permit loopback Supabase development."""
    if not value:
        return value
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid Supabase URL") from exc
    if (
        not host
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or (port is not None and port == 0)
    ):
        raise ValueError("Supabase URL must be an origin without credentials")
    local = host == "localhost"
    try:
        local = local or ip_address(host).is_loopback
    except ValueError:
        pass
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ValueError("Supabase URL requires HTTPS except on loopback hosts")
    return value.rstrip("/")


class Settings(BaseSettings):
    """Application settings loaded from environment variables.

    Pydantic Settings reads env vars automatically:
      SUPABASE_URL env var -> settings.supabase_url
    Case-insensitive matching, so SUPABASE_URL matches supabase_url.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # App
    app_name: str = "FreshPlate API"
    debug: bool = False

    # Supabase
    supabase_url: str = ""
    # Preferred non-JWT key for low-privilege server-side Data API reads.
    supabase_publishable_key: str = ""
    # Legacy JWT key retained as a transition fallback.
    supabase_anon_key: str = ""
    # Backend-only key for atomic feed writes and local corpus ingestion.
    supabase_secret_key: SecretStr = SecretStr("")
    # Legacy JWT key retained as a transition fallback. Never expose either
    # elevated key to mobile or other public clients.
    supabase_service_role_key: SecretStr = SecretStr("")

    # JWT verification — Supabase uses asymmetric (ES256) JWKS by default.
    # Expected audience claim for normal user tokens.
    supabase_jwt_audience: str = "authenticated"
    # JWKS cache TTL in seconds (1 hour per architecture decisions).
    jwks_cache_ttl_seconds: int = 3600
    # HTTP timeout for the JWKS fetch.
    jwks_fetch_timeout_seconds: float = 5.0

    @field_validator("supabase_url")
    @classmethod
    def secure_supabase_url(cls, value: str) -> str:
        return validate_supabase_url(value)

    @property
    def supabase_jwks_url(self) -> str:
        """Derive the JWKS URL from supabase_url.

        Returns an empty string when unset so tests can override the fetch path.
        """
        if not self.supabase_url:
            return ""
        return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"

    # Gemini (Phase 5)
    gemini_api_key: str = ""

    # LangSmith reads these environment variables directly when LangGraph
    # tracing is enabled. Declaring them here keeps the application settings
    # model compatible with the optional values in backend/.env.
    langsmith_tracing: bool = False
    langsmith_api_key: str = ""
    langsmith_endpoint: str = ""
    langsmith_project: str = ""

    ai_pipeline_budget_seconds: float = Field(default=25.0, gt=0, lt=30.0)
    recipe_feed_initial_budget_seconds: float = Field(default=30.0, gt=0, lt=35.0)
    recipe_feed_page_budget_seconds: float = Field(default=30.0, gt=0, lt=35.0)
    recipe_feed_store_timeout_seconds: float = Field(default=2.0, gt=0, lt=5.0)

    # Server
    host: str = "0.0.0.0"
    port: int = 8000


# Singleton
settings = Settings()
