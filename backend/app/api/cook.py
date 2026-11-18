"""Cook endpoints: plan the done-cooking checklist and deduct a confirmed cook."""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.auth import CurrentUserId
from app.core.config import settings
from app.models.cook import CookPlanRequest, CookPlanResponse
from app.models.recipes import CookConfirmationRequest
from app.services.cook_checklist import build_checklist
from app.services.food_lines import (
    FoodLinesError,
    FoodLineSource,
    SupabaseFoodLineSource,
)

router = APIRouter(prefix="/api/cook", tags=["cook"])

# cook_recipe_v2 messages the app acts on, by the error they become.
_APP_ERRORS = {
    "STOCK_CHANGED": "Some ingredients changed since the checklist loaded",
    "COOK_ALREADY_CONFIRMED": "This cook was already confirmed",
}


def get_cook_food_source(request: Request) -> FoodLineSource:
    """Read the caller's household foods with the caller's own token."""
    _, _, token = request.headers.get("authorization", "").partition(" ")
    return SupabaseFoodLineSource(
        token, http_client=request.app.state.supabase_http_client
    )


@router.post("/plan", response_model=CookPlanResponse)
async def plan_cook_checklist(
    payload: CookPlanRequest,
    _user_id: CurrentUserId,
    foods: FoodLineSource = Depends(get_cook_food_source),
) -> CookPlanResponse:
    """Plan the done-cooking checklist for a recipe against current stock.

    Reads the household's foods with unexpired stock as the caller, converts
    each ingredient into its food's stock base and sums each food's lines.
    Changes nothing, so the app calls it again to reload stock.

    Args:
        payload: The household and the cooked recipe's ingredients.
        _user_id: The authenticated caller. Supabase reads it again from the
            JWT.
        foods: Where the household's foods are read from.

    Returns:
        ``{"data": {"foods": [...], "untracked": [...]}}`` as described by
        ``CookPlanData``.

    Raises:
        HTTPException: 401 when the caller is not signed in. 503
            ``COOK_UNAVAILABLE`` when the household's foods can't be read.
    """
    try:
        lines = await foods.list_food_lines(payload.household_id)
    except FoodLinesError as exc:
        raise HTTPException(
            status_code=503,
            detail={"error": "Cook service unavailable", "code": "COOK_UNAVAILABLE"},
        ) from exc
    return CookPlanResponse(data=build_checklist(payload.ingredients, lines))


@router.post("/confirm")
async def confirm_cook(
    payload: CookConfirmationRequest,
    _user_id: CurrentUserId,
    request: Request,
):
    """Deduct a confirmed cook from the household's batches and record it.

    Forwards the caller's JWT to the ``cook_recipe_v2`` Postgres function, so
    membership checks and the cook event's user come from the caller. That
    function's ``COMMENT ON FUNCTION`` defines the draw order, idempotency and
    error codes.

    Args:
        payload: The cook to confirm.
        _user_id: The authenticated caller. Postgres reads it again from the JWT.
        request: The incoming request, whose bearer token is forwarded.

    Returns:
        ``{"data": {...}}`` with ``cook_event_id``, ``operation_id`` and one
        deduction per line: ``inventory_item_id``, ``food_id``,
        ``confirmed_amount``, ``committed_amount`` and ``draws``
        (``[{lot_id, amount}]``), plus ``lines``: the request's ingredient
        lines with ``food_id``, ``stock_base``, their share of the ``draws``
        and ``shortfall`` added.

    Raises:
        HTTPException: 401 or 403 when Supabase rejects the caller. 409
            ``STOCK_CHANGED`` when a food has less unexpired stock than its
            deduction's ``expected_amount``. Nothing is deducted, and the app
            reloads stock and asks the person to check those lines. 409
            ``COOK_ALREADY_CONFIRMED`` when the operation id already recorded
            a cook with a different payload, such as a retry after a lost
            response. Nothing more is deducted. 409 ``COOK_REJECTED`` when
            Postgres refuses the cook for another reason, for example for an
            unknown food, a fractional amount on a whole-units food, or lines
            that don't match the deductions. A request that
            races a food merge is also refused, and the app may retry it. 502
            ``COOK_REJECTED`` for any other Supabase error. 503
            ``COOK_UNAVAILABLE`` when Supabase is not configured or can't be
            reached.
    """
    token = request.headers.get("authorization", "")
    key = settings.supabase_publishable_key or settings.supabase_anon_key
    if not settings.supabase_url or not key:
        raise HTTPException(
            status_code=503,
            detail={"error": "Cook service unavailable", "code": "COOK_UNAVAILABLE"},
        )
    try:
        response = await request.app.state.supabase_http_client.post(
            f"{settings.supabase_url}/rest/v1/rpc/cook_recipe_v2",
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
                "p_lines": [line.model_dump(mode="json") for line in payload.lines],
            },
            timeout=10,
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail={"error": "Cook service unavailable", "code": "COOK_UNAVAILABLE"},
        ) from exc
    message = _postgres_message(response) if response.status_code == 400 else None
    if message in _APP_ERRORS:
        raise HTTPException(
            status_code=409,
            detail={"error": _APP_ERRORS[message], "code": message},
        )
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


def _postgres_message(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    return body.get("message") if isinstance(body, dict) else None
