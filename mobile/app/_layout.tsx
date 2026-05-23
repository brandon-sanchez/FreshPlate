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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Toast from "react-native-toast-message";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { toastConfig } from "@/components/toastConfig";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      retry: 1,
    },
  },
});

// Re-export ErrorBoundary so Expo Router can catch rendering crashes in this layout.
export { ErrorBoundary } from "expo-router";

// Tells Expo Router which tab to show first when the app opens.
export const unstable_settings = {
  initialRouteName: "(tabs)",
};

// Keep the splash screen visible until fonts are loaded.
SplashScreen.preventAutoHideAsync();

//  Root Layout
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

function SafeAreaToast() {
  const insets = useSafeAreaInsets();

  return <Toast config={toastConfig} topOffset={Math.max(insets.top, 8)} />;
}

//  Navigation + Auth Guard
function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const router = useRouter();
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
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider
          value={colorScheme === "dark" ? DarkTheme : DefaultTheme}
        >
          <Stack>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="item/[id]" />
            <Stack.Screen
              name="set-name"
              options={{ headerShown: false, presentation: "modal" }}
            />
          </Stack>
        </ThemeProvider>
        <SafeAreaToast />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
