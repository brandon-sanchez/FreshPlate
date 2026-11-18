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
    openai_api_key: SecretStr = SecretStr("")

    # Generated recipe and ingredient photos
    image_generation_enabled: bool = False
    # Global cap for recipe and ingredient images combined, per UTC month.
    image_generation_monthly_cap_microusd: int = Field(default=10_000_000, ge=0)
    # Cap per requesting user per UTC month, so one account cannot use up the
    # global cap with made-up food names.
    image_generation_user_monthly_cap_microusd: int = Field(default=2_000_000, ge=0)
    # Spend reserved per attempt: the published low-quality output price for
    # 1536x1024 ($0.005) or 1024x1024 ($0.006), plus headroom for prompt tokens.
    recipe_image_cost_microusd: int = Field(default=12_000, gt=0)
    ingredient_image_cost_microusd: int = Field(default=12_000, gt=0)
    image_generation_max_attempts: int = Field(default=2, ge=1, le=5)
    image_generation_retry_after_seconds: int = Field(default=900, ge=0)
    image_generation_timeout_seconds: float = Field(default=120.0, gt=0, le=300)
    image_signed_url_ttl_seconds: int = Field(default=86_400, ge=60)
    image_store_timeout_seconds: float = Field(default=10.0, gt=0, le=60)

    # LangSmith reads these environment variables directly when LangGraph
    # tracing is enabled. Declaring them here keeps the application settings
    # model compatible with the optional values in backend/.env.
    langsmith_tracing: bool = False
    langsmith_api_key: str = ""
    langsmith_endpoint: str = ""
    langsmith_project: str = ""

    ai_pipeline_budget_seconds: float = Field(default=25.0, gt=0, lt=30.0)
    # Feed budgets include the batch's photos: the recipe steps stop
    # PHOTO_RESERVE_SECONDS early to leave them time. Each must stay under
    # the app's 50 s request timeout (RECIPE_FEED_REQUEST_TIMEOUT_MS in
    # mobile/lib/recipe-feed-api.ts) with room for a Lambda cold start, which
    # runs before the budget starts, so the app sees the server's answer.
    # tests/test_request_budgets.py checks that room. The recipe steps need
    # about 16 s to generate, then at least 10 s (GEMINI_MIN_DEADLINE_SECONDS)
    # still on their deadline to start the quality check.
    recipe_feed_initial_budget_seconds: float = Field(default=41.0, gt=0, lt=50.0)
    # A refill must also finalize before its claim expires, 45 s after
    # claim_recipe_feed_refill grants it.
    recipe_feed_page_budget_seconds: float = Field(default=41.0, gt=0, lt=45.0)
    recipe_feed_store_timeout_seconds: float = Field(default=2.0, gt=0, lt=5.0)
    # Reading a session back generates nothing, so the app falls back to its
    # empty feed quickly instead of waiting out a generation budget.
    recipe_feed_restore_budget_seconds: float = Field(default=3.0, gt=0, lt=45.0)

    # Server
    host: str = "0.0.0.0"
    port: int = 8000


# Singleton
settings = Settings()
