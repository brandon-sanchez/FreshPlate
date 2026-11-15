-- Migration: add_image_asset_lifecycle
--
-- Completes the generated-image ledger. A claim reserves spend under the global
-- monthly cap and the requesting user's monthly cap before any provider call.
-- The backend then settles the claim with the stored image or releases it on
-- failure. A failed image can be claimed again only after a cooldown and up to
-- a fixed number of billable attempts, so no request loop can keep spending.
-- Image files live in a private Storage bucket.

DROP FUNCTION public.reserve_image_asset(TEXT, TEXT, BIGINT, BIGINT);

ALTER TABLE public.image_assets
    ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 0),
    ADD COLUMN reserved_by UUID,
    ADD COLUMN lease_expires_at TIMESTAMPTZ,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Rows from the earlier reserve-only function have no lease. Expiring them at
-- creation lets the next claim count them as charged attempts.
UPDATE public.image_assets
   SET lease_expires_at = created_at
 WHERE status = 'reserved' AND lease_expires_at IS NULL;

ALTER TABLE public.image_assets
    ADD CONSTRAINT image_assets_ready_has_object
        CHECK (status <> 'ready' OR object_path IS NOT NULL),
    ADD CONSTRAINT image_assets_reserved_has_lease
        CHECK (status <> 'reserved' OR lease_expires_at IS NOT NULL);

CREATE TABLE public.image_generation_user_months (
    user_id UUID NOT NULL,
    month_start DATE NOT NULL,
    reserved_cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cost_microusd >= 0),
    PRIMARY KEY (user_id, month_start)
);

ALTER TABLE public.image_generation_user_months ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_generation_user_months FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.image_generation_user_months TO service_role;

COMMENT ON TABLE public.image_generation_user_months IS
    'Image generation spend per requesting user per UTC month, in micro-dollars. '
    'Bounds how much of the global cap one account can use, since food names are '
    'user text. user_id has no foreign key so the spend record outlives the account. '
    'Service role only.';

COMMENT ON TABLE public.image_generation_months IS
    'Global image generation spend per UTC month, in micro-dollars. Reserved before '
    'each provider call and reduced only when a failure is known to be unbilled. '
    'Written by the service role through the image asset functions only.';

COMMENT ON TABLE public.image_assets IS
    'One generated image per (kind, cache_key): a recipe snapshot or an ingredient '
    'identity. status is reserved while a generation runs, ready once object_path '
    'holds the file in the generated-images bucket, and failed after a provider or '
    'storage failure. Service role only.';

COMMENT ON COLUMN public.image_assets.cache_key IS
    'Hex SHA-256 of the recipe content or ingredient identity, computed by the backend.';
COMMENT ON COLUMN public.image_assets.object_path IS
    'Path of the WebP file inside the generated-images Storage bucket. NULL until ready.';
COMMENT ON COLUMN public.image_assets.reservation_id IS
    'Identifies the current attempt. settle and release must present it, so a '
    'worker whose lease expired cannot finish a newer attempt.';
COMMENT ON COLUMN public.image_assets.reserved_cost_microusd IS
    'Spend reserved for the current attempt, charged to reservation_month.';
COMMENT ON COLUMN public.image_assets.attempts IS
    'Possibly billed provider attempts for this image, including the current one. '
    'A refunded attempt is not counted.';
COMMENT ON COLUMN public.image_assets.reserved_by IS
    'User whose monthly cap the current attempt is charged to.';
COMMENT ON COLUMN public.image_assets.lease_expires_at IS
    'When a reserved attempt is presumed dead. Its spend stays charged and a later '
    'claim may start the next attempt. NULL unless status is reserved.';

CREATE FUNCTION public.claim_image_asset(
    p_kind TEXT,
    p_cache_key TEXT,
    p_requester UUID,
    p_cost_microusd BIGINT,
    p_monthly_cap_microusd BIGINT,
    p_requester_cap_microusd BIGINT,
    p_max_attempts INTEGER,
    p_retry_after_seconds INTEGER,
    p_lease_seconds INTEGER
)
RETURNS TABLE(outcome TEXT, asset_id UUID, reservation_id UUID, object_path TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_asset public.image_assets;
    v_month DATE := date_trunc('month', timezone('utc', now()))::date;
    v_reservation UUID := gen_random_uuid();
    v_lease TIMESTAMPTZ;
BEGIN
    IF p_kind IS NULL OR p_kind NOT IN ('recipe', 'ingredient')
       OR p_cache_key IS NULL OR btrim(p_cache_key) = ''
       OR p_requester IS NULL
       OR p_cost_microusd IS NULL OR p_cost_microusd <= 0
       OR p_monthly_cap_microusd IS NULL OR p_monthly_cap_microusd <= 0
       OR p_requester_cap_microusd IS NULL OR p_requester_cap_microusd <= 0
       OR p_max_attempts IS NULL OR p_max_attempts < 1
       OR p_retry_after_seconds IS NULL OR p_retry_after_seconds < 0
       OR p_lease_seconds IS NULL OR p_lease_seconds < 1 THEN
        RAISE EXCEPTION 'invalid image claim' USING ERRCODE = '22023';
    END IF;
    v_lease := now() + make_interval(secs => p_lease_seconds);

    -- The key lock serializes claims for one image before its row exists, so
    -- concurrent first requests produce one reservation.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_cache_key, 0));
    SELECT * INTO v_asset FROM public.image_assets a
     WHERE a.kind = p_kind AND a.cache_key = p_cache_key
       FOR UPDATE;

    IF FOUND THEN
        IF v_asset.status = 'ready' THEN
            RETURN QUERY SELECT 'ready', v_asset.id, NULL::uuid, v_asset.object_path;
            RETURN;
        END IF;
        IF v_asset.status = 'reserved' AND v_asset.lease_expires_at > now() THEN
            RETURN QUERY SELECT 'in_progress', v_asset.id, NULL::uuid, NULL::text;
            RETURN;
        END IF;
        IF v_asset.status = 'reserved' THEN
            UPDATE public.image_assets
               SET status = 'failed', lease_expires_at = NULL, updated_at = now()
             WHERE id = v_asset.id
            RETURNING * INTO v_asset;
        ELSIF v_asset.updated_at > now() - make_interval(secs => p_retry_after_seconds) THEN
            RETURN QUERY SELECT 'failed', v_asset.id, NULL::uuid, NULL::text;
            RETURN;
        END IF;
        IF v_asset.attempts >= p_max_attempts THEN
            RETURN QUERY SELECT 'failed', v_asset.id, NULL::uuid, NULL::text;
            RETURN;
        END IF;
    END IF;

    -- The month row lock serializes every reservation, so concurrent claims
    -- for different images cannot pass the cap checks together. The user row
    -- is always locked after it, in the same order as release.
    INSERT INTO public.image_generation_months(month_start)
    VALUES (v_month) ON CONFLICT (month_start) DO NOTHING;
    PERFORM 1 FROM public.image_generation_months m
     WHERE m.month_start = v_month FOR UPDATE;
    INSERT INTO public.image_generation_user_months(user_id, month_start)
    VALUES (p_requester, v_month) ON CONFLICT (user_id, month_start) DO NOTHING;
    PERFORM 1 FROM public.image_generation_user_months u
     WHERE u.user_id = p_requester AND u.month_start = v_month FOR UPDATE;
    IF (SELECT m.reserved_cost_microusd FROM public.image_generation_months m
         WHERE m.month_start = v_month) + p_cost_microusd > p_monthly_cap_microusd
       OR (SELECT u.reserved_cost_microusd FROM public.image_generation_user_months u
            WHERE u.user_id = p_requester AND u.month_start = v_month)
          + p_cost_microusd > p_requester_cap_microusd THEN
        RETURN QUERY SELECT 'budget_exhausted', v_asset.id, NULL::uuid, NULL::text;
        RETURN;
    END IF;
    UPDATE public.image_generation_months m
       SET reserved_cost_microusd = m.reserved_cost_microusd + p_cost_microusd
     WHERE m.month_start = v_month;
    UPDATE public.image_generation_user_months u
       SET reserved_cost_microusd = u.reserved_cost_microusd + p_cost_microusd
     WHERE u.user_id = p_requester AND u.month_start = v_month;

    IF v_asset.id IS NULL THEN
        INSERT INTO public.image_assets(
            kind, cache_key, status, reservation_id, reserved_cost_microusd,
            reservation_month, reserved_by, lease_expires_at
        )
        VALUES (p_kind, p_cache_key, 'reserved', v_reservation, p_cost_microusd,
                v_month, p_requester, v_lease)
        RETURNING * INTO v_asset;
    ELSE
        UPDATE public.image_assets
           SET status = 'reserved',
               reservation_id = v_reservation,
               reserved_cost_microusd = p_cost_microusd,
               reservation_month = v_month,
               reserved_by = p_requester,
               attempts = attempts + 1,
               lease_expires_at = v_lease,
               updated_at = now()
         WHERE id = v_asset.id;
    END IF;
    RETURN QUERY SELECT 'claimed', v_asset.id, v_reservation, NULL::text;
END;
$$;

CREATE FUNCTION public.settle_image_asset(
    p_asset_id UUID,
    p_reservation_id UUID,
    p_object_path TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
    WITH settled AS (
        UPDATE public.image_assets
           SET status = 'ready', object_path = p_object_path,
               lease_expires_at = NULL, updated_at = now()
         WHERE id = p_asset_id AND reservation_id = p_reservation_id
           AND status = 'reserved' AND nullif(btrim(p_object_path), '') IS NOT NULL
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM settled)
$$;

CREATE FUNCTION public.release_image_asset(
    p_asset_id UUID,
    p_reservation_id UUID,
    p_refund BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_asset public.image_assets;
BEGIN
    UPDATE public.image_assets
       SET status = 'failed', lease_expires_at = NULL, updated_at = now(),
           attempts = attempts - CASE WHEN p_refund THEN 1 ELSE 0 END
     WHERE id = p_asset_id AND reservation_id = p_reservation_id
       AND status = 'reserved'
    RETURNING * INTO v_asset;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF p_refund THEN
        UPDATE public.image_generation_months
           SET reserved_cost_microusd = reserved_cost_microusd - v_asset.reserved_cost_microusd
         WHERE month_start = v_asset.reservation_month;
        UPDATE public.image_generation_user_months
           SET reserved_cost_microusd = reserved_cost_microusd - v_asset.reserved_cost_microusd
         WHERE user_id = v_asset.reserved_by AND month_start = v_asset.reservation_month;
    END IF;
    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.claim_image_asset(TEXT, TEXT, UUID, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER) IS
    'Claims the right to generate one image, reserving spend under the monthly caps.

Parameters: p_kind is recipe or ingredient. p_cache_key identifies the image.
p_requester is the user charged for the attempt. p_cost_microusd is the spend
to reserve. p_monthly_cap_microusd is the cap for the current UTC month across
all kinds and users. p_requester_cap_microusd is the cap for p_requester in that
month. The caller owns all caps and bounds, so every backend must pass the same
values. p_max_attempts bounds possibly billed attempts per image. p_retry_after_seconds is the cooldown after a failure. p_lease_seconds
is how long a claimed attempt may run before a later claim presumes it dead.

Returns one row. outcome is ready (object_path set), claimed (reservation_id
set: call the provider, then settle or release), in_progress, failed (attempts
exhausted or cooling down), or budget_exhausted (either cap). asset_id is NULL only for
budget_exhausted on a never-claimed image.

Raises 22023 "invalid image claim" for a bad argument. SECURITY INVOKER.
Callable by service_role only.';

COMMENT ON FUNCTION public.settle_image_asset(UUID, UUID, TEXT) IS
    'Marks a claimed image ready at p_object_path, keeping its reserved spend as the charge.

Returns false when p_reservation_id is not the asset''s current reserved
attempt, for example after its lease expired and another claim started.
SECURITY INVOKER. Callable by service_role only.';

COMMENT ON FUNCTION public.release_image_asset(UUID, UUID, BOOLEAN) IS
    'Marks a claimed image failed, refunding its reserved spend when p_refund is true.

Pass p_refund only when the provider is known not to have billed, such as an
error response. A refund credits both caps for the month the spend was
reserved in, and the attempt stops counting toward the attempt limit.
Returns false when p_reservation_id is not the asset''s current reserved
attempt. SECURITY INVOKER. Callable by service_role only.';

REVOKE ALL ON FUNCTION public.claim_image_asset(TEXT, TEXT, UUID, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER),
    public.settle_image_asset(UUID, UUID, TEXT),
    public.release_image_asset(UUID, UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_image_asset(TEXT, TEXT, UUID, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER),
    public.settle_image_asset(UUID, UUID, TEXT),
    public.release_image_asset(UUID, UUID, BOOLEAN)
    TO service_role;

-- Private: no storage.objects policies exist for this bucket, so clients can
-- neither list nor write it. The backend uploads with its secret key and hands
-- clients short-lived signed URLs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('generated-images', 'generated-images', false, 2097152, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
