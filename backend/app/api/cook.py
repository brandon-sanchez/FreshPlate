"""Authenticated atomic cook confirmation endpoint."""
import httpx
from fastapi import APIRouter, HTTPException, Request

from app.core.auth import CurrentUserId
from app.core.config import settings
from app.models.recipes import CookConfirmationRequest

router = APIRouter(prefix="/api/cook", tags=["cook"])

@router.post("/confirm")
async def confirm_cook(
    payload: CookConfirmationRequest,
    _user_id: CurrentUserId,
    request: Request,
):
    token = request.headers.get("authorization", "")
    key = settings.supabase_publishable_key or settings.supabase_anon_key
    if not settings.supabase_url or not key:
        raise HTTPException(
            status_code=503,
            detail={"error": "Cook service unavailable", "code": "COOK_UNAVAILABLE"},
        )
    try:
        response = await request.app.state.supabase_http_client.post(
            f"{settings.supabase_url}/rest/v1/rpc/cook_recipe",
            headers={
                "apikey": key,
                "Authorization": token,
                "Content-Type": "application/json",
            },
            json={
                "p_household_id": str(payload.household_id),
                "p_operation_id": str(payload.operation_id),
                "p_recipe_id": str(payload.recipe_id),
                "p_recipe_snapshot": payload.recipe_snapshot,
                "p_deductions": [
                    line.model_dump(mode="json") for line in payload.deductions
                ],
            },
            timeout=10,
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail={"error": "Cook service unavailable", "code": "COOK_UNAVAILABLE"},
        ) from exc
    if response.is_error:
        raise HTTPException(
            status_code=(
                response.status_code
                if response.status_code in (401, 403)
                else 409
                if response.status_code in (400, 409)
                else 502
            ),
            detail={"error": "Cook confirmation failed", "code": "COOK_REJECTED"},
        )
    return {"data": response.json()}
