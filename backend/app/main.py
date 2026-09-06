from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.ai.prompts.loader import load_prompt
from app.api.barcode import router as barcode_router
from app.api.cook import router as cook_router
from app.api.health import router as health_router
from app.api.me import router as me_router
from app.api.recipes import router as recipes_router
from app.core.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Reuse Supabase HTTP connections and close them when the app shuts down."""
    load_prompt("generate_recipes")
    async with httpx.AsyncClient() as client:
        app.state.supabase_http_client = client
        yield


def create_app() -> FastAPI:
    """Application factory — creates and configures the FastAPI instance."""
    app = FastAPI(
        title=settings.app_name,
        lifespan=lifespan,
        docs_url="/docs" if settings.debug else None,
        redoc_url="/redoc" if settings.debug else None,
    )

    configure_exception_handlers(app)

    app.include_router(health_router)
    app.include_router(me_router)
    app.include_router(barcode_router)
    app.include_router(cook_router)
    app.include_router(recipes_router)

    return app


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
