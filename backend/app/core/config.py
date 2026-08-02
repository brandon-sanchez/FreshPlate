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
    supabase_anon_key: str = ""

    # JWT verification — Supabase uses asymmetric (ES256) JWKS by default.
    # Expected audience claim for normal user tokens.
    supabase_jwt_audience: str = "authenticated"
    # JWKS cache TTL in seconds (1 hour per architecture decisions).
    jwks_cache_ttl_seconds: int = 3600
    # HTTP timeout for the JWKS fetch.
    jwks_fetch_timeout_seconds: float = 5.0

    @property
    def supabase_jwks_url(self) -> str:
        """Derive the JWKS URL from supabase_url. Empty string if unset (tests override)."""
        if not self.supabase_url:
            return ""
        return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"

    # Gemini (Phase 5)
    gemini_api_key: str = ""

    # Server
    host: str = "0.0.0.0"
    port: int = 8000


# Singleton — import this everywhere
settings = Settings()
