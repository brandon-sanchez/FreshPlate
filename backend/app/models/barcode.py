"""Pydantic DTOs for the barcode lookup endpoint."""

from __future__ import annotations

from pydantic import BaseModel, Field


class BarcodeLookupRequest(BaseModel):
    # EAN-8 (8) through EAN-13/UPC-A (12-13) and UPC-E (8). 8-14 digits covers them all
    # plus the occasional ITF-14 case packs (which OFF indexes too).
    barcode: str = Field(min_length=8, max_length=14, pattern=r"^\d{8,14}$")


class BarcodeProduct(BaseModel):
    barcode: str
    name: str | None = None
    brand: str | None = None
    quantity: str | None = None
    categories: list[str] = Field(default_factory=list)
    image_url: str | None = None
    # Only populated when settings.debug is true; otherwise omitted by the route.
    raw_off_data: dict | None = None


class BarcodeLookupResponse(BaseModel):
    data: BarcodeProduct | None = None
