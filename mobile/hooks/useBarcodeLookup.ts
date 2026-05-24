import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { BarcodeLookupResponse } from "@/types/barcode";

const BARCODE_PATTERN = /^\d{8,14}$/;

export function isValidBarcode(barcode: string | null | undefined): barcode is string {
  return typeof barcode === "string" && BARCODE_PATTERN.test(barcode);
}

export function useBarcodeLookup(barcode: string | null | undefined) {
  const enabled = isValidBarcode(barcode);

  return useQuery<BarcodeLookupResponse>({
    queryKey: ["barcode", barcode],
    queryFn: () =>
      apiFetch<BarcodeLookupResponse>("/api/barcode/lookup", {
        method: "POST",
        body: JSON.stringify({ barcode }),
      }),
    // Backend caches OFF lookups (positive + negative) for 7 days; no point re-fetching.
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
    enabled,
    retry: 1,
  });
}
