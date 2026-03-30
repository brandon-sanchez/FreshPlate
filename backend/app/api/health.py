from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    """Health check endpoint for Cloud Run and monitoring."""
    return {"status": "healthy", "service": "freshplate-api"}
