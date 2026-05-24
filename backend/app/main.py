from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.barcode import router as barcode_router
from app.api.health import router as health_router
from app.api.me import router as me_router
from app.core.config import settings


def create_app() -> FastAPI:
    """Application factory — creates and configures the FastAPI instance."""
    app = FastAPI(
        title=settings.app_name,
        docs_url="/docs" if settings.debug else None,
        redoc_url="/redoc" if settings.debug else None,
    )

    configure_cors(app)
    configure_exception_handlers(app)

    app.include_router(health_router)
    app.include_router(me_router)
    app.include_router(barcode_router)

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


def configure_cors(app: FastAPI) -> None:
    """Add CORS middleware so the mobile app and web clients can call the API."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


app = create_app()
