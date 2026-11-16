"""Authenticated endpoints that return recipe photos and ingredient thumbnails.

A request may trigger one paid generation, so both endpoints are POST. Each
loads its subject with the caller's JWT first: a recipe or food the caller's
households cannot read is a 404 and never reaches the spend ledger.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.auth import CurrentUserId
from app.services.image_service import (
    ImageResult,
    ImageService,
    ImageStoreError,
    ImageSubjects,
)
from app.services.image_store import SupabaseImageSubjects

router = APIRouter(prefix="/api/images", tags=["images"])

_NOT_FOUND = {"error": "Image subject not found", "code": "IMAGE_SUBJECT_NOT_FOUND"}
_UNAVAILABLE = {"error": "Image service unavailable", "code": "IMAGE_UNAVAILABLE"}


def get_image_service(request: Request) -> ImageService:
    """Return the process-wide image service created at startup."""
    return request.app.state.image_service


def get_image_subjects(request: Request) -> ImageSubjects:
    """Return caller-scoped recipe and food reads using the request's JWT."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer":
        token = ""
    return SupabaseImageSubjects(request.app.state.supabase_http_client, token.strip())


@router.post("/recipes/{recipe_id}")
async def recipe_image(
    recipe_id: UUID,
    user_id: CurrentUserId,
    subjects: ImageSubjects = Depends(get_image_subjects),
    images: ImageService = Depends(get_image_service),
) -> dict[str, ImageResult]:
    """Return the photo for a recipe in the caller's feed or saved recipes.

    The first request for a feed recipe generates the photo. Later requests,
    from any view, reuse it. A saved recipe gets the photo of the matching
    feed snapshot when one was generated. It never starts a generation,
    because members write saved recipes directly.

    Returns:
        `{"data": ImageResult}`. Status 200 includes `pending` and
        `unavailable`, for which the screen shows its placeholder.

    Raises:
        HTTPException: 401 for a missing or invalid JWT. 404
            `IMAGE_SUBJECT_NOT_FOUND` when the caller cannot see the recipe.
            503 `IMAGE_UNAVAILABLE` when Supabase cannot be reached.
    """
    try:
        recipe = await subjects.find_feed_recipe(user_id, recipe_id)
        generate = recipe is not None
        recipe = recipe or await subjects.find_saved_recipe(recipe_id)
        if recipe is None:
            raise HTTPException(status_code=404, detail=_NOT_FOUND)
        result = await images.recipe_image(recipe, user_id, generate=generate)
        return {"data": result}
    except ImageStoreError as exc:
        raise HTTPException(status_code=503, detail=_UNAVAILABLE) from exc


@router.post("/foods/{food_id}")
async def food_image(
    food_id: UUID,
    user_id: CurrentUserId,
    subjects: ImageSubjects = Depends(get_image_subjects),
    images: ImageService = Depends(get_image_service),
) -> dict[str, ImageResult]:
    """Return the thumbnail for a food in one of the caller's households.

    Foods with the same profile or normalized name share one thumbnail, so
    adding another tomato costs nothing.

    Returns:
        `{"data": ImageResult}`, as for recipe photos.

    Raises:
        HTTPException: 401 for a missing or invalid JWT. 404
            `IMAGE_SUBJECT_NOT_FOUND` when the food is not in the caller's
            households. 503 `IMAGE_UNAVAILABLE` when Supabase cannot be reached.
    """
    try:
        food = await subjects.find_food(food_id)
        if food is None:
            raise HTTPException(status_code=404, detail=_NOT_FOUND)
        return {"data": await images.food_image(food, user_id)}
    except ImageStoreError as exc:
        raise HTTPException(status_code=503, detail=_UNAVAILABLE) from exc
