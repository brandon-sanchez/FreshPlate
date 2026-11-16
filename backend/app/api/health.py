from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    """Report that the API is up, for deploy checks and uptime monitoring."""
    return {"status": "healthy", "service": "freshplate-api"}
