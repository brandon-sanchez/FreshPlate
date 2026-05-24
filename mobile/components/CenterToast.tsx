import { useEffect } from "react";
import { Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useCenterToast, type CenterToastTone } from "@/stores/centerToast";
import { useTheme } from "@/hooks/useTheme";

const ENTER_DURATION_MS = 180;
const EXIT_DURATION_MS = 220;

export default function CenterToast() {
  const { colors, fonts } = useTheme();
  const visible = useCenterToast((s) => s.visible);
  const icon = useCenterToast((s) => s.icon);
  const text = useCenterToast((s) => s.text);
  const tone = useCenterToast((s) => s.tone);
  const durationMs = useCenterToast((s) => s.durationMs);
  const hide = useCenterToast((s) => s.hide);

  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.85);

  useEffect(() => {
    if (!visible) return;
    opacity.value = withTiming(1, { duration: ENTER_DURATION_MS });
    scale.value = withSpring(1, { damping: 14, stiffness: 220, mass: 0.7 });
    const timer = setTimeout(() => {
      opacity.value = withTiming(
        0,
        { duration: EXIT_DURATION_MS },
        (finished) => {
          if (finished) runOnJS(hide)();
        },
      );
      scale.value = withTiming(0.85, { duration: EXIT_DURATION_MS });
    }, durationMs);
    return () => clearTimeout(timer);
  }, [visible, durationMs, hide, opacity, scale]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: opacity.value * 0.18,
  }));

  const cardStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  if (!visible) return null;

  const iconBgColor = iconBg(tone, colors);
  const iconColor = iconFg(tone, colors);

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "#000",
          },
          backdropStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            backgroundColor: colors.surface,
            borderRadius: 26,
            paddingHorizontal: 36,
            paddingVertical: 32,
            alignItems: "center",
            gap: 16,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 12 },
            shadowOpacity: 0.22,
            shadowRadius: 28,
            elevation: 12,
            minWidth: 200,
            maxWidth: 280,
          },
          cardStyle,
        ]}
      >
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: iconBgColor,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FontAwesome
            name={icon as React.ComponentProps<typeof FontAwesome>["name"]}
            size={32}
            color={iconColor}
          />
        </View>
        <Text
          style={{
            fontFamily: fonts.display,
            fontSize: 18,
            color: colors.text,
            letterSpacing: -0.3,
            textAlign: "center",
          }}
        >
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}

function iconBg(
  tone: CenterToastTone,
  colors: ReturnType<typeof useTheme>["colors"],
): string {
  // Theme has no critSoft token yet; literal rgba is the temporary stand-in.
  if (tone === "danger") return "rgba(184,68,56,0.16)";
  if (tone === "neutral") return colors.surfaceAlt;
  return colors.accentSoft;
}

function iconFg(
  tone: CenterToastTone,
  colors: ReturnType<typeof useTheme>["colors"],
): string {
  if (tone === "danger") return colors.crit;
  if (tone === "neutral") return colors.text;
  return colors.accent;
}
