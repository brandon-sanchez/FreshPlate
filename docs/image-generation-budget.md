# Image generation budget

The `image_assets` table deduplicates recipe and ingredient image requests by
`kind` and `cache_key`. The `reserve_image_asset` RPC creates one conservative
monthly reservation before a future provider call. The backend passes the
configured UTC month cap and estimated cost in integer micro-USD units.

The default disabled cap is zero. Invalid or non-positive cost and cap values
create a failed, non-billable asset record. Existing reserved, ready, or failed
assets are returned without a new reservation, so retries cannot create an
untracked provider attempt. Only `service_role` can execute the RPC or read the
tables.
