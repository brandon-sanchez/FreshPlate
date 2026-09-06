# Image generation budget

The `image_assets` table deduplicates recipe and ingredient images by `kind`
and `cache_key`. Before calling an image provider, the backend reserves an
estimated upper-bound cost through `reserve_image_asset`. Costs and the global
monthly cap use integer millionths of a US dollar.

Only a new reservation with `is_new=true` permits a provider attempt. Existing
assets return the same reservation with `is_new=false`, including failed
attempts whose charges are unknown. Reservations retain their charge until a
future settlement process can safely reconcile it.

A zero or missing cap disables reservations. Invalid requests do not create
assets or consume capacity. Reservations record their UTC month and serialize
concurrent requests so duplicate assets and simultaneous requests cannot
reserve beyond the cap. Only `service_role` can access the tables or RPC.

This migration provides spending controls only. Provider calls, cache delivery,
and recipe and ingredient photos are follow-up work in #56. The cap remains
unconfigured, and no billable image generation is enabled.
