"""The image result returned by the image endpoints and carried by feed cards.

It depends on nothing else in the app, so both the recipe graph and
`app.services.image_service` can import it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

UnavailableReason = Literal["disabled", "budget_exhausted", "failed"]


class ImageResult(BaseModel):
    """What a screen shows for one image.

    Attributes:
        status: `ready` when `url` serves the image, `pending` while another
            request generates it, or `unavailable` when the screen shows its
            placeholder.
        image_key: Stable identity of the image, the same for every view of
            one dish or ingredient. Suitable as a client cache key,
            since `url` changes each time it is signed.
        url: Signed URL of the WebP image. Set only when ready.
        expires_at: When `url` stops working. Set only when ready.
        reason: Why the image is unavailable. `disabled`: generation is off
            or unconfigured, or the recipe can only be served from cache.
            `budget_exhausted`: the global or the caller's monthly cap is
            reached. `failed`: the last attempt failed, or the request had
            too little time left to make one. A later request may retry
            after the cooldown, up to the attempt limit, but a prompt over
            the provider limit always fails. Set only when unavailable.
    """

    status: Literal["ready", "pending", "unavailable"]
    image_key: str
    url: str | None = None
    expires_at: datetime | None = None
    reason: UnavailableReason | None = None

    @classmethod
    def pending(cls, image_key: str) -> ImageResult:
        """Return the result for an image another request is generating."""
        return cls(status="pending", image_key=image_key)

    @classmethod
    def unavailable(cls, image_key: str, reason: UnavailableReason) -> ImageResult:
        """Return the placeholder result for `reason`."""
        return cls(status="unavailable", image_key=image_key, reason=reason)
