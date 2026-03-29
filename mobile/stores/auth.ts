import { create } from "zustand";
import { Session, User } from "@supabase/supabase-js";
import * as WebBrowser from "expo-web-browser";
import * as AppleAuthentication from "expo-apple-authentication";
import { supabase } from "@/lib/supabase";

// Where Supabase redirects after OAuth login completes.
// Must match what's registered in: Supabase Dashboard → Auth → URL Configuration.
const REDIRECT_URL = "freshplate://auth/callback";

/**
 * Extracts session tokens from an OAuth callback URL.
 *
 * After Google/Apple auth, Supabase redirects to something like:
 *   freshplate://auth/callback#access_token=eyJ...&refresh_token=abc...
 *
 * The "#" separates the base URL from the "fragment" containing the tokens.
 * (Similar to Python's urllib.parse.parse_qs() for query strings.)
 */
function extractSessionFromUrl(url: string) {
  const hashPart = url.split("#")[1];
  if (!hashPart) return null;

  // URLSearchParams parses key=value pairs (like Python's dict(parse_qsl(...)))
  const params = new URLSearchParams(hashPart);
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");

  if (!access_token || !refresh_token) return null;
  return { access_token, refresh_token };
}

// ─── Store Type Definition ───────────────────────────────────────────────────
// Think of this like a Python TypedDict — it defines the exact shape of our store.
// Every property and function listed here must exist in the store below.
type AuthState = {
  session: Session | null; // null = not logged in (like Python's Optional[Session])
  user: User | null;
  isLoading: boolean;
  initialize: () => void;
  signInWithGoogle: () => Promise<void>; // async function (like Python's async def)
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
};

// Prevents double-initialization. React's Strict Mode (dev only) re-runs effects,
// which would create duplicate auth listeners without this guard.
let initialized = false;

// ─── Auth Store ──────────────────────────────────────────────────────────────
// create<AuthState>() builds a Zustand store matching the AuthState shape.
// `set` is the function used to update state (triggers re-renders in components using the store).
export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  isLoading: true, // starts true — we haven't checked for a saved session yet

  initialize: () => {
    if (initialized) return;
    initialized = true;

    // Check AsyncStorage for a saved session from a previous app launch.
    // Uses .then() because Zustand's create callback can't be async.
    supabase.auth.getSession().then(({ data: { session } }) => {
      set({ session, user: session?.user ?? null, isLoading: false });
      // session?.user  → "optional chaining" — returns undefined if session is null
      // ?? null        → "nullish coalescing" — fallback to null if left side is null/undefined
      // Python equivalent: session.user if session else None
    });

    // Listen for all future auth changes (sign in, sign out, token refresh).
    // This runs for the lifetime of the app — no cleanup needed.
    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null });
    });
  },

  // ─── Google OAuth Flow (3 steps) ────────────────────────────────────────
  signInWithGoogle: async () => {
    // Step 1: Get the Google OAuth URL from Supabase
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: REDIRECT_URL,
        skipBrowserRedirect: true, // we'll open the browser ourselves
      },
    });

    if (error) throw error;
    if (!data.url) throw new Error("No OAuth URL returned");

    // Step 2: Open an in-app browser for the user to sign in with Google
    const result = await WebBrowser.openAuthSessionAsync(
      data.url,
      REDIRECT_URL
    );

    // Step 3: If auth completed, extract tokens and create the session
    if (result.type === "success") {
      const tokens = extractSessionFromUrl(result.url);
      if (tokens) {
        const { error: sessionError } = await supabase.auth.setSession(tokens);
        if (sessionError) throw sessionError;
        // onAuthStateChange fires automatically after setSession → store updates
      }
    }
    // If result.type is "cancel" or "dismiss", the user closed the browser — nothing to do
  },

  // ─── Apple Sign-In (native iOS dialog) ──────────────────────────────────
  signInWithApple: async () => {
    // Uses a native iOS dialog — no browser needed.
    // The login screen hides this button on Android since it's iOS-only.
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!credential.identityToken) {
      throw new Error("No identity token from Apple");
    }

    // Exchange the Apple token for a Supabase session.
    // signInWithIdToken is for native flows where we already have a token,
    // unlike signInWithOAuth which opens a browser.
    const { error } = await supabase.auth.signInWithIdToken({
      provider: "apple",
      token: credential.identityToken,
    });

    if (error) throw error;
    // onAuthStateChange fires automatically → store updates
  },

  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    // No manual state clearing needed — onAuthStateChange fires with a null session
  },
}));
