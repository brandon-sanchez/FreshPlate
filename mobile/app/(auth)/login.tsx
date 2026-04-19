import { useState, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
  AccessibilityInfo,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import * as AppleAuthentication from "expo-apple-authentication";
import { StatusBar } from "expo-status-bar";
import { useAuthStore } from "@/stores/auth";
import { useTheme } from "@/hooks/useTheme";

function getSignInErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("network") || msg.includes("fetch")) {
      return "Check your internet connection and try again.";
    }
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export default function LoginScreen() {
  const [isLoading, setIsLoading] = useState<"google" | "apple" | null>(null);
  const { colors, colorScheme } = useTheme();

  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle);
  const signInWithApple = useAuthStore((s) => s.signInWithApple);

  const brandOpacity = useSharedValue(0);
  const brandTranslateY = useSharedValue(20);
  const buttonsOpacity = useSharedValue(0);
  const buttonsTranslateY = useSharedValue(30);

  const brandAnimatedStyle = useAnimatedStyle(() => ({
    opacity: brandOpacity.value,
    transform: [{ translateY: brandTranslateY.value }],
  }));

  const buttonsAnimatedStyle = useAnimatedStyle(() => ({
    opacity: buttonsOpacity.value,
    transform: [{ translateY: buttonsTranslateY.value }],
  }));

  useEffect(() => {
    const animate = async () => {
      const reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();

      if (reduceMotion) {
        brandOpacity.value = 1;
        brandTranslateY.value = 0;
        buttonsOpacity.value = 1;
        buttonsTranslateY.value = 0;
        return;
      }

      const easing = Easing.out(Easing.cubic);
      brandOpacity.value = withTiming(1, { duration: 600, easing });
      brandTranslateY.value = withTiming(0, { duration: 600, easing });
      buttonsOpacity.value = withDelay(
        250,
        withTiming(1, { duration: 500, easing }),
      );
      buttonsTranslateY.value = withDelay(
        250,
        withTiming(0, { duration: 500, easing }),
      );
    };

    animate();
  }, []);

  const handleGoogleSignIn = async () => {
    setIsLoading("google");
    try {
      await signInWithGoogle();
    } catch (error) {
      Alert.alert("Sign In Error", getSignInErrorMessage(error));
    } finally {
      setIsLoading(null);
    }
  };

  const handleAppleSignIn = async () => {
    setIsLoading("apple");
    try {
      await signInWithApple();
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === "ERR_REQUEST_CANCELED") return;
      Alert.alert("Sign In Error", getSignInErrorMessage(error));
    } finally {
      setIsLoading(null);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <Animated.View style={[styles.header, brandAnimatedStyle]}>
        <View style={[styles.iconCircle, { backgroundColor: colors.accentSoft }]}>
          <Ionicons name="leaf-outline" size={32} color={colors.accent} />
        </View>
        <Text style={[styles.title, { color: colors.accent }]}>FreshPlate</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
          Track your fridge. Cook smarter.
        </Text>
      </Animated.View>

      <Animated.View style={buttonsAnimatedStyle}>
        <View style={styles.buttons}>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                shadowColor: colors.text,
              },
              pressed && styles.buttonPressed,
            ]}
            onPress={handleGoogleSignIn}
            disabled={isLoading !== null}
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            accessibilityState={{
              disabled: isLoading !== null,
              busy: isLoading === "google",
            }}
          >
            {isLoading === "google" ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <View style={styles.buttonContent}>
                <Ionicons name="logo-google" size={18} color={colors.text} />
                <Text style={[styles.googleButtonText, { color: colors.text }]}>
                  Continue with Google
                </Text>
              </View>
            )}
          </Pressable>

          {Platform.OS === "ios" && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={
                AppleAuthentication.AppleAuthenticationButtonType.CONTINUE
              }
              buttonStyle={
                colorScheme === "dark"
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={12}
              style={styles.appleButton}
              onPress={handleAppleSignIn}
            />
          )}
        </View>

        <Text style={[styles.privacyNote, { color: colors.textSubtle }]}>
          We only use your name and email to create your account.
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 28,
    justifyContent: "center",
    paddingBottom: 80,
  },
  header: {
    alignItems: "center",
    marginBottom: 40,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    letterSpacing: 0.2,
  },
  buttons: {
    gap: 14,
  },
  button: {
    height: 52,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  buttonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.98 }],
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  appleButton: {
    height: 52,
  },
  privacyNote: {
    fontSize: 13,
    textAlign: "center",
    marginTop: 20,
  },
});
