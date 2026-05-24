"""Open Food Facts lookup with 7-day in-memory cache.

Both hits and misses are cached (negative caching) so repeated scans of an
unknown product don't keep hammering OFF. Cache is keyed on raw barcode.
"""

from __future__ import annotations

from typing import Any

import httpx
from cachetools import TTLCache

from app.core.config import settings
from app.models.barcode import BarcodeProduct

_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
_CACHE_MAX_ENTRIES = 1000

# `None` entries are confirmed misses (negative cache), distinct from "key absent".
_lookup_cache: TTLCache[str, BarcodeProduct | None] = TTLCache(
    maxsize=_CACHE_MAX_ENTRIES, ttl=_CACHE_TTL_SECONDS
)

_OFF_BASE_URL = "https://world.openfoodfacts.org/api/v2/product"
_OFF_FIELDS = "product_name,brands,quantity,categories_tags,image_url"
# OFF rate-limits anonymous traffic aggressively; identifying ourselves is required.
_USER_AGENT = "FreshPlate/0.1 (https://github.com/brandon-sanchez/FreshPlate)"
_HTTP_TIMEOUT_SECONDS = 5.0


class BarcodeUpstreamError(Exception):
    """Raised when OFF is unreachable or returns 5xx — caller converts to 502."""


def _reset_cache_for_tests() -> None:
    """Test helper — clears the module-level lookup cache between cases."""
    _lookup_cache.clear()


def _strip_category_tag(tag: str) -> str:
    """OFF category tags look like `en:dairy-products`. Strip the `xx:` prefix
    and lowercase. If no prefix, return as-is lowercased.
    """
    if ":" in tag:
        _, _, rest = tag.partition(":")
        return rest.lower()
    return tag.lower()


def _first_brand(brands: str | None) -> str | None:
    """OFF returns brands as a comma-separated string. Take the first."""
    if not brands:
        return None
    first = brands.split(",", 1)[0].strip()
    return first or None


def _parse_off_product(barcode: str, payload: dict[str, Any]) -> BarcodeProduct | None:
    """Convert an OFF API v2 payload to a BarcodeProduct, or None if not found."""
    if payload.get("status") != 1:
        return None
    product = payload.get("product") or {}
    categories = [
        _strip_category_tag(tag)
        for tag in (product.get("categories_tags") or [])
        if isinstance(tag, str) and tag
    ]
    return BarcodeProduct(
        barcode=barcode,
        name=product.get("product_name") or None,
        brand=_first_brand(product.get("brands")),
        quantity=product.get("quantity") or None,
        categories=categories,
        image_url=product.get("image_url") or None,
        raw_off_data=payload if settings.debug else None,
    )


async def lookup_barcode(barcode: str) -> BarcodeProduct | None:
    """Look up `barcode` against Open Food Facts.

    Returns a BarcodeProduct on hit, None when OFF doesn't know the barcode.
    Raises BarcodeUpstreamError on timeout or 5xx (caller converts to 502).
    Caches both outcomes for 7 days.
    """
    if barcode in _lookup_cache:
        return _lookup_cache[barcode]

    url = f"{_OFF_BASE_URL}/{barcode}.json"
    headers = {"User-Agent": _USER_AGENT}
    params = {"fields": _OFF_FIELDS}

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.HTTPError as exc:
        raise BarcodeUpstreamError(f"OFF request failed: {exc}") from exc

    # 5xx only — 404 + `status: 0` (unknown barcode) is handled downstream.
    if 500 <= response.status_code < 600:
        raise BarcodeUpstreamError(f"OFF returned {response.status_code}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise BarcodeUpstreamError("OFF returned non-JSON body") from exc

    product = _parse_off_product(barcode, payload)
    _lookup_cache[barcode] = product
    return product
