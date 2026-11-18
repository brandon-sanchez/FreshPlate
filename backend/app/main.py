import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.ai.images import OpenAIImageProvider
from app.ai.prompts.loader import load_prompt
from app.api.barcode import router as barcode_router
from app.api.cook import router as cook_router
from app.api.health import router as health_router
from app.api.images import router as images_router
from app.api.me import router as me_router
from app.api.recipes import router as recipes_router
from app.core import tracing
from app.core.config import settings
from app.services.image_service import ImagePolicy, ImageService
from app.services.image_store import SupabaseImageStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Share Supabase connections and the image service, then close them."""
    load_prompt("generate_recipes")
    async with httpx.AsyncClient() as client:
        app.state.supabase_http_client = client
        policy = ImagePolicy.from_settings(settings)
        app.state.image_service = ImageService(
            SupabaseImageStore(client),
            OpenAIImageProvider(
                settings.openai_api_key,
                enabled=policy.enabled,
                monthly_cap_microusd=policy.monthly_cap_microusd,
            ),
            policy,
        )
        yield


def create_app() -> FastAPI:
    """Application factory — creates and configures the FastAPI instance."""
    app = FastAPI(
        title=settings.app_name,
        lifespan=lifespan,
        docs_url="/docs" if settings.debug else None,
        redoc_url="/redoc" if settings.debug else None,
    )

    configure_logging()
    configure_exception_handlers(app)
    if settings.langsmith_tracing:
        app.add_middleware(tracing.TraceFlushMiddleware, flush=tracing.flush_traces)

    app.include_router(health_router)
    app.include_router(me_router)
    app.include_router(barcode_router)
    app.include_router(cook_router)
    app.include_router(recipes_router)
    app.include_router(images_router)

    return app


def configure_logging() -> None:
    """Send the app's INFO records to stderr beside uvicorn's own logs.

    Uvicorn configures only its own loggers, so without this the per-call
    Gemini timing and token records and the feed summaries are dropped.
    """
    logger = logging.getLogger("freshplate")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(levelname)s:     %(name)s %(message)s")
        )
        logger.addHandler(handler)


def configure_exception_handlers(app: FastAPI) -> None:
    """Project convention: error responses are `{"error": "...", "code": "..."}` at the
    top level. When a handler raises HTTPException with a dict detail matching that
    shape, surface it directly instead of wrapping it under `detail`.
    """

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
        if isinstance(exc.detail, dict) and "error" in exc.detail:
            return JSONResponse(
                status_code=exc.status_code,
                content=exc.detail,
                headers=exc.headers,
            )
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": str(exc.detail), "code": f"HTTP_{exc.status_code}"},
            headers=exc.headers,
        )


app = create_app()
