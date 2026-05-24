from fastapi import APIRouter

from app.core.auth import CurrentUserId

router = APIRouter(prefix="/api", tags=["auth"])


@router.get("/me")
async def get_me(user_id: CurrentUserId) -> dict:
    """Returns the caller's Supabase user id. Used to smoke-test JWT auth."""
    return {"data": {"user_id": user_id}}
