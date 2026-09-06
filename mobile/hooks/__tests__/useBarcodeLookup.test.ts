import React from "react";
import { cleanupAsync, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Supabase auth.getSession is called from apiFetch to grab the access token.
const mockGetSession = jest.fn().mockResolvedValue({
  data: { session: { access_token: "test-token" } },
});

jest.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: () => mockGetSession() } },
}));

import { useBarcodeLookup, isValidBarcode } from "@/hooks/useBarcodeLookup";

// The hook sets its own gcTime (30 min), and per-query options override client
// defaults, so a gcTime: 0 default cannot cancel its GC timer. Instead each
// test gets a fresh client and afterEach calls client.clear(), which drops the
// cache and its timers so they cannot outlive the test run.
let client: QueryClient;

/** Creates a query client configured for deterministic barcode hook tests. */
function createTestClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Per-query retry: 1 in the hook overrides retry: false; retryDelay: 0
        // keeps the test fast when the retry does fire.
        retryDelay: 0,
      },
    },
  });
}

/** Supplies the barcode hook with the test query client. */
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

const originalFetch = global.fetch;

function mockFetchResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Partial<Response>);
}

describe("useBarcodeLookup", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    client = createTestClient();
  });

  afterEach(async () => {
    await cleanupAsync();
    client.clear();
    global.fetch = originalFetch;
  });

  it("calls /api/barcode/lookup with the barcode and bearer token", async () => {
    const product = {
      barcode: "0073914000000",
      name: "Fage 2%",
      brand: "Fage",
      quantity: "17.6 oz",
      categories: ["dairy-products"],
      image_url: null,
    };
    global.fetch = mockFetchResponse({ data: product }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBarcodeLookup("0073914000000"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toMatch(/\/api\/barcode\/lookup$/);
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ barcode: "0073914000000" });

    const headers = call[1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(result.current.data).toEqual({ data: product });
  });

  it("resolves successfully with {data: null} when the product is unknown", async () => {
    global.fetch = mockFetchResponse({ data: null }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBarcodeLookup("9999999999999"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ data: null });
    expect(result.current.isError).toBe(false);
  });

  it("surfaces ApiError on non-2xx responses", async () => {
    global.fetch = mockFetchResponse(
      { error: "Upstream down", code: "BARCODE_LOOKUP_UPSTREAM_ERROR" },
      { ok: false, status: 502 },
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useBarcodeLookup("0073914000000"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3000 });
    expect(result.current.error?.message).toBe("Upstream down");
  });

  it("does not fetch when the barcode is malformed", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { result } = renderHook(() => useBarcodeLookup("not-a-barcode"), {
      wrapper,
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("isValidBarcode", () => {
  it("accepts 8 to 14 digit numeric strings", () => {
    expect(isValidBarcode("12345678")).toBe(true);
    expect(isValidBarcode("01234567890123")).toBe(true);
  });

  it("rejects non-numeric, too-short, or empty input", () => {
    expect(isValidBarcode("")).toBe(false);
    expect(isValidBarcode(null)).toBe(false);
    expect(isValidBarcode(undefined)).toBe(false);
    expect(isValidBarcode("1234567")).toBe(false);
    expect(isValidBarcode("123456789012345")).toBe(false);
    expect(isValidBarcode("abcdefgh")).toBe(false);
  });
});
