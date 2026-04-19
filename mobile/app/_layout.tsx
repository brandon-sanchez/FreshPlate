import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import "react-native-reanimated";

import { useColorScheme } from "react-native";
import { useAuthStore } from "@/stores/auth";
import { Inter_400Regular, Inter_600SemiBold } from "@expo-google-fonts/inter";
import { Fraunces_500Medium } from "@expo-google-fonts/fraunces";

// Re-export ErrorBoundary so Expo Router can catch rendering crashes in this layout.
export { ErrorBoundary } from "expo-router";

// Tells Expo Router which tab to show first when the app opens.
export const unstable_settings = {
  initialRouteName: "(tabs)",
};

// Keep the splash screen visible until fonts are loaded.
SplashScreen.preventAutoHideAsync();

// ─── Root Layout ─────────────────────────────────────────────────────────────
// This is the first component Expo Router renders. It loads fonts,
// then hands off to RootLayoutNav which handles auth + navigation.
export default function RootLayout() {
  // useFonts returns [loaded: boolean, error: Error | null]
  const [loaded, error] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
    ...FontAwesome.font,
    Inter_400Regular,
    Inter_600SemiBold,
    Fraunces_500Medium,
  });

  // If font loading fails, throw so ErrorBoundary catches it
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  // Once fonts are ready, hide the splash screen
  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  // Show nothing until fonts load (splash screen is still visible)
  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

// ─── Navigation + Auth Guard ─────────────────────────────────────────────────
// Sets up the navigation stack and redirects users based on login status.
function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const router = useRouter();

  // useSegments() returns the current route as an array of path parts.
  // Example: /(auth)/login → ["(auth)", "login"]
  // Example: /(tabs)/index → ["(tabs)"]
  const segments = useSegments();

  // Pull auth state from our Zustand store (each selector grabs one field)
  const session = useAuthStore((s) => s.session);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);

  // On app start: check for a saved session and set up the auth listener.
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Auth guard — redirects users whenever session or route changes.
  // Protects the main app from unauthenticated access.
  useEffect(() => {
    if (isLoading) return; // still checking for saved session — don't redirect yet

    const inAuthGroup = segments[0] === "(auth)";

    if (!session && !inAuthGroup) {
      // Not logged in + not on login screen → send to login
      router.replace("/(auth)/login");
    } else if (session && inAuthGroup) {
      // Logged in + still on login screen → send to main app
      router.replace("/(tabs)");
    }
  }, [session, isLoading, segments]);

  // ThemeProvider gives all child screens access to light/dark theme colors.
  // Stack defines the available screen groups for navigation.
  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}
