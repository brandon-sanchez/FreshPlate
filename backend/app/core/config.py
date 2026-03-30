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

    # CORS — origins allowed to call this API (add Cloud Run URL in production)
    allowed_origins: list[str] = [
        "http://localhost:8081",
        "http://localhost:19006",
        "http://localhost:8000",
    ]

    # Gemini (Phase 5)
    gemini_api_key: str = ""

    # Server
    host: str = "0.0.0.0"
    port: int = 8000


# Singleton — import this everywhere
settings = Settings()
