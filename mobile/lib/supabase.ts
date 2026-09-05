// ─── Supabase Client ─────────────────────────────────────────────────────────
// Creates a single Supabase client used throughout the app for auth, database,
// and realtime features. Imported as: import { supabase } from "@/lib/supabase"

import { createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// These come from your .env file. The "!" tells TypeScript "trust me, these exist."
// EXPO_PUBLIC_ prefix makes them available in the app (Expo strips other env vars for security).
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabasePublishableKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY or " +
      "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  );
}

const isWebServer = Platform.OS === "web" && typeof window === "undefined";

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    // AsyncStorage = React Native's key-value storage (like Python's shelve).
    // Lets Supabase save/restore the session so users stay logged in across app restarts.
    storage: isWebServer ? undefined : AsyncStorage,
    autoRefreshToken: !isWebServer,
    persistSession: !isWebServer,
    detectSessionInUrl: Platform.OS === "web" && !isWebServer,
  },
});
