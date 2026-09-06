import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import { useTheme } from "@/hooks/useTheme";

export default function GlassTabBackground() {
  const { colors, colorScheme } = useTheme();
  const [reduceTransparency, setReduceTransparency] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (active) setReduceTransparency(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  const shape = {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 38,
    overflow: "hidden" as const,
  };
  if (reduceTransparency || Platform.OS !== "ios") {
    return (
      <View
        style={[
          shape,
          {
            backgroundColor: colors.surface,
            borderWidth: 0.5,
            borderColor: colors.border,
          },
        ]}
      />
    );
  }
  if (isGlassEffectAPIAvailable() && isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme={colorScheme}
        style={shape}
      />
    );
  }
  return (
    <BlurView
      intensity={80}
      tint={
        colorScheme === "dark"
          ? "systemChromeMaterialDark"
          : "systemChromeMaterialLight"
      }
      style={shape}
    />
  );
}
