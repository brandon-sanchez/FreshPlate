"""Barcode lookup endpoint — calls Open Food Facts via the service layer."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.core.auth import CurrentUserId
from app.models.barcode import BarcodeLookupRequest, BarcodeLookupResponse
from app.services.barcode_service import BarcodeUpstreamError, lookup_barcode

router = APIRouter(prefix="/api/barcode", tags=["barcode"])


@router.post("/lookup", response_model=BarcodeLookupResponse)
async def post_barcode_lookup(
    payload: BarcodeLookupRequest,
    _user_id: CurrentUserId,
) -> BarcodeLookupResponse:
    """Look up a barcode against Open Food Facts.

    Returns `{"data": null}` when the barcode is well-formed but OFF has no record
    of it (HTTP 200 — the API worked, the product is just unknown). 502 when OFF
    itself is unreachable or 5xx-ing.
    """
    try:
        product = await lookup_barcode(payload.barcode)
    except BarcodeUpstreamError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "error": "Barcode lookup service unavailable",
                "code": "BARCODE_LOOKUP_UPSTREAM_ERROR",
            },
        ) from exc

    return BarcodeLookupResponse(data=product)
