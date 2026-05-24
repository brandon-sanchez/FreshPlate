import { supabase } from "@/lib/supabase";

const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "") ?? "http://localhost:8000";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type ApiErrorBody = {
  error?: string;
  code?: string;
  detail?: string | { error?: string; code?: string };
};

async function readAccessToken(): Promise<string | null> {
  // Read from the client (not the Zustand store) to pick up any background
  // refresh; the store can lag a tick after a silent refresh.
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await readAccessToken();

  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  const response = await fetch(url, { ...init, headers });

  const text = await response.text();
  const parsed: unknown = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const { message, code } = extractErrorShape(parsed, response.statusText);
    throw new ApiError(response.status, message, code);
  }

  return parsed as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorShape(
  body: unknown,
  fallback: string,
): { message: string; code: string | null } {
  if (body && typeof body === "object") {
    const b = body as ApiErrorBody;
    if (typeof b.error === "string") {
      return { message: b.error, code: b.code ?? null };
    }
    if (b.detail && typeof b.detail === "object" && typeof b.detail.error === "string") {
      return { message: b.detail.error, code: b.detail.code ?? null };
    }
    if (typeof b.detail === "string") {
      return { message: b.detail, code: null };
    }
  }
  return { message: fallback || "Request failed", code: null };
}

export const API_URL_FOR_DEBUG = API_BASE_URL;
