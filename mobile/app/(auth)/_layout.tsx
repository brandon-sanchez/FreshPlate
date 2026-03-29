import { Stack } from "expo-router";

// Layout for the (auth) route group — wraps all auth-related screens.
// Stack means screens push on top of each other (like a navigation stack).
// headerShown: false hides the default nav bar — the login screen has its own UI.
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
