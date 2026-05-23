import { create } from "zustand";
import { Session, User } from "@supabase/supabase-js";
import * as WebBrowser from "expo-web-browser";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
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

// Store Type Definition
type AuthState = {
  session: Session | null;
  user: User | null;
  householdId: string | null;
  isLoading: boolean;
  initialize: () => void;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
};

/**
 * Best-effort first name from OAuth provider metadata.
 * Google sets `given_name`/`full_name`/`name`; Apple writes `full_name` on first auth
 * (after we persist it). Returns null if nothing usable was supplied — caller should
 * fall back to the profiles.display_name column or prompt the user.
 */
export function firstNameFromMetadata(user: User | null): string | null {
  if (!user) return null;
  const meta = user.user_metadata ?? {};
  const given = (meta.given_name as string | undefined)?.trim();
  if (given) return given;
  const full =
    (meta.full_name as string | undefined)?.trim() ||
    (meta.name as string | undefined)?.trim();
  if (full) {
    const first = full.split(/\s+/)[0];
    if (first) return first;
  }
  return null;
}

/**
 * Returns the user's household_id.
 * - `string` — household found.
 * - `null` — no row (permanent broken: signup trigger failed).
 * - throws  — DB / network error (transient: caller decides).
 */
async function loadHouseholdId(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return data?.household_id ?? null;
}

let initialized = false;

//  Auth Store
export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  householdId: null,
  isLoading: true, // starts true — we haven't checked for a saved session yet

  initialize: () => {
    if (initialized) return;
    initialized = true;

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) {
        set({ session: null, user: null, householdId: null, isLoading: false });
        return;
      }
      try {
        const hh = await loadHouseholdId(session.user.id);
        if (hh === null) {
          set({
            session: null,
            user: null,
            householdId: null,
            isLoading: false,
          });
          await supabase.auth.signOut();
          return;
        } else {
          set({
            session,
            user: session.user,
            householdId: hh,
            isLoading: false,
          });
        }
      } catch (_err) {
        console.error("Failed to load household:", _err);
        set({ session: null, user: null, householdId: null, isLoading: false });
        await supabase.auth.signOut();
      }
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      (async () => {
        if (!session?.user) {
          set({
            session: null,
            user: null,
            householdId: null,
            isLoading: false,
          });
          return;
        }
        try {
          const hh = await loadHouseholdId(session.user.id);
          if (hh === null) {
            set({
              session: null,
              user: null,
              householdId: null,
              isLoading: false,
            });
            await supabase.auth.signOut();
            return;
          } else {
            set({
              session,
              user: session.user,
              householdId: hh,
              isLoading: false,
            });
          }
        } catch (_err) {
          console.error("Failed to refetch household:", _err);
          set({
            session: null,
            user: null,
            householdId: null,
            isLoading: false,
          });
          await supabase.auth.signOut();
        }
      })();
    });
  },

  // Google OAuth Flow
  signInWithGoogle: async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: REDIRECT_URL,
        skipBrowserRedirect: true,
      },
    });

    if (error) throw error;
    if (!data.url) throw new Error("No OAuth URL returned");

    /*
     * Race openAuthSessionAsync against a Linking listener.
     *
     * The system sometimes intercepts the redirect to `freshplate://auth/callback`
     * before openAuthSessionAsync resolves — the browser sheet dismisses but the
     * promise hangs forever. The Linking listener catches that deep link as a
     * fallback so the auth flow always completes.
     */
    const redirectUrl = await new Promise<string | null>((resolve) => {
      let settled = false;

      const finish = (url: string | null) => {
        if (settled) return;
        settled = true;
        subscription.remove();
        WebBrowser.dismissAuthSession();
        resolve(url);
      };

      const subscription = Linking.addEventListener("url", ({ url }) => {
        if (url.startsWith(REDIRECT_URL)) finish(url);
      });

      WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URL).then((result) => {
        finish(result.type === "success" ? result.url : null);
      });
    });

    if (!redirectUrl) return;

    const tokens = extractSessionFromUrl(redirectUrl);
    if (!tokens) return;

    const { error: sessionError } = await supabase.auth.setSession(tokens);
    if (sessionError) throw sessionError;
  },

  //  Apple Sign-In
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
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: "apple",
      token: credential.identityToken,
    });

    if (error) throw error;

    // Apple only returns fullName on the *first* sign-in. Persist it immediately
    // so future sessions don't lose access to the user's real name. Don't let a
    // profile-write failure tank the whole sign-in — the user can edit later.
    const given = credential.fullName?.givenName?.trim();
    const family = credential.fullName?.familyName?.trim();
    if (given && data.user) {
      const displayName = [given, family].filter(Boolean).join(" ");
      try {
        await supabase
          .from("profiles")
          .update({ display_name: displayName })
          .eq("id", data.user.id);
      } catch (err) {
        console.warn("Failed to persist Apple display_name:", err);
      }
    }
  },

  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },
}));
