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
import FontAwesome from "@expo/vector-icons/FontAwesome";
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
  const { colors, colorScheme, fonts } = useTheme();

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
          <Ionicons name="leaf-outline" size={36} color={colors.accent} />
        </View>
        <Text
          style={[
            styles.title,
            { color: colors.text, fontFamily: fonts.display },
          ]}
        >
          FreshPlate
        </Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
          Track your fridge. Cook smarter.
        </Text>

        <View style={styles.featureGrid}>
          <FeatureTile
            icon="barcode"
            label="Scan"
            sublabel="Barcodes"
            colors={colors}
            fonts={fonts}
          />
          <FeatureTile
            icon="camera"
            label="Snap"
            sublabel="Groceries"
            colors={colors}
            fonts={fonts}
          />
          <FeatureTile
            icon="cutlery"
            label="Cook"
            sublabel="AI recipes"
            colors={colors}
            fonts={fonts}
          />
        </View>
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

function FeatureTile({
  icon,
  label,
  sublabel,
  colors,
  fonts,
}: {
  icon: React.ComponentProps<typeof FontAwesome>["name"];
  label: string;
  sublabel: string;
  colors: ReturnType<typeof useTheme>["colors"];
  fonts: ReturnType<typeof useTheme>["fonts"];
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 14,
        paddingVertical: 14,
        alignItems: "center",
        gap: 6,
      }}
    >
      <FontAwesome name={icon} size={18} color={colors.accent} />
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 12.5,
          color: colors.text,
          letterSpacing: -0.1,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 10.5,
          color: colors.textMuted,
        }}
      >
        {sublabel}
      </Text>
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
    width: 80,
    height: 80,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 18,
  },
  title: {
    fontSize: 36,
    letterSpacing: -0.7,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    letterSpacing: 0.1,
  },
  featureGrid: {
    flexDirection: "row",
    gap: 8,
    width: "100%",
    marginTop: 28,
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
