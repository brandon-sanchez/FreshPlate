-- Global monthly image reservation ledger. Provider settlement is deliberately
-- separate from reservation so failures retain their conservative charge.
CREATE TABLE public.image_generation_months (
    month_start DATE PRIMARY KEY,
    reserved_cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cost_microusd >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.image_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('recipe', 'ingredient')),
    cache_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'ready', 'failed')),
    object_path TEXT,
    reservation_id UUID UNIQUE,
    reserved_cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cost_microusd >= 0),
    reservation_month DATE REFERENCES public.image_generation_months(month_start),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, cache_key)
);

ALTER TABLE public.image_generation_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.image_generation_months FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.image_assets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.image_generation_months, public.image_assets TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_image_asset(
    p_kind TEXT,
    p_cache_key TEXT,
    p_cost_microusd BIGINT,
    p_monthly_cap_microusd BIGINT
)
RETURNS TABLE(asset_id UUID, reservation_id UUID, is_new BOOLEAN, status TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_asset public.image_assets;
    v_month DATE := date_trunc('month', timezone('utc', now()))::date;
    v_reservation UUID;
BEGIN
    IF p_kind IS NULL OR btrim(p_kind) = '' OR p_cache_key IS NULL OR btrim(p_cache_key) = ''
       OR p_cost_microusd IS NULL OR p_cost_microusd <= 0
       OR p_monthly_cap_microusd IS NULL OR p_monthly_cap_microusd <= 0 THEN
        RETURN;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_cache_key, 0));
    SELECT * INTO v_asset FROM public.image_assets
      WHERE kind = p_kind AND cache_key = p_cache_key FOR UPDATE;
    IF FOUND THEN
        RETURN QUERY SELECT v_asset.id, v_asset.reservation_id, false, v_asset.status;
        RETURN;
    END IF;
    INSERT INTO public.image_generation_months(month_start)
    VALUES (v_month) ON CONFLICT (month_start) DO NOTHING;
    PERFORM 1 FROM public.image_generation_months WHERE month_start = v_month FOR UPDATE;
    IF (SELECT reserved_cost_microusd FROM public.image_generation_months WHERE month_start = v_month)
       + p_cost_microusd > p_monthly_cap_microusd THEN
        RETURN;
    END IF;
    v_reservation := gen_random_uuid();
    UPDATE public.image_generation_months
       SET reserved_cost_microusd = reserved_cost_microusd + p_cost_microusd
     WHERE month_start = v_month;
    INSERT INTO public.image_assets(kind, cache_key, status, reservation_id, reserved_cost_microusd, reservation_month)
    VALUES (p_kind, p_cache_key, 'reserved', v_reservation, p_cost_microusd, v_month)
    RETURNING id INTO asset_id;
    reservation_id := v_reservation;
    is_new := true;
    status := 'reserved';
    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_image_asset(TEXT, TEXT, BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_image_asset(TEXT, TEXT, BIGINT, BIGINT) TO service_role;
