from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    # Preferred non-JWT key for local corpus ingestion and other trusted jobs.
    supabase_secret_key: str = ""
    # Legacy JWT key retained as a transition fallback. Never expose either
    # elevated key to mobile or other public clients.
    supabase_service_role_key: str = ""

    # JWT verification — Supabase uses asymmetric (ES256) JWKS by default.
    # Expected audience claim for normal user tokens.
    supabase_jwt_audience: str = "authenticated"
    # JWKS cache TTL in seconds (1 hour per architecture decisions).
    jwks_cache_ttl_seconds: int = 3600
    # HTTP timeout for the JWKS fetch.
    jwks_fetch_timeout_seconds: float = 5.0

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

    # Shared server-side budget for the future recipe pipeline. This stays
    # below the mobile client's 30-second request abort window.
    ai_pipeline_budget_seconds: float = Field(default=25.0, gt=0, lt=30.0)

    # Server
    host: str = "0.0.0.0"
    port: int = 8000


# Singleton — import this everywhere
settings = Settings()
