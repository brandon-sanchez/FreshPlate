import { useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { BlurView } from "expo-blur";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import { useTheme } from "@/hooks/useTheme";

type GlassMode = "liquid" | "blur" | "solid";

function useGlassMode({ tinted }: { tinted: boolean }): GlassMode {
  const [reduceTransparency, setReduceTransparency] = useState<
    boolean | null
  >(null);
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
  const transparencyAllowed = reduceTransparency === false;
  if (!transparencyAllowed || Platform.OS !== "ios") return "solid";
  if (isGlassEffectAPIAvailable() && isLiquidGlassAvailable()) return "liquid";
  return tinted ? "solid" : "blur";
}

type GlassSurfaceProps = {
  /** Corner radius in points. Half the height gives a capsule or a circle. */
  radius: number;
  /**
   * Color the glass takes on, like a prominent iOS glass button. Without it
   * the surface is untinted glass, or `surface` where glass is off.
   */
  tint?: string;
  /**
   * Lets Liquid Glass flex and brighten under a finger. Set it only on a
   * surface that is itself the pressed control.
   */
  interactive?: boolean;
  /** Size and position of the surface. */
  style?: StyleProp<ViewStyle>;
  /** Content drawn on top of the glass, such as an icon. */
  children?: ReactNode;
};

/**
 * Renders a Liquid Glass surface with a blur or solid fallback, for the app's
 * floating chrome such as the tab bar and its Add button.
 */
export default function GlassSurface({
  radius,
  tint,
  interactive = false,
  style,
  children,
}: GlassSurfaceProps) {
  const { colors, colorScheme } = useTheme();
  const mode = useGlassMode({ tinted: tint !== undefined });
  const shape: ViewStyle = { borderRadius: radius, overflow: "hidden" };

  if (mode === "liquid") {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme={colorScheme}
        tintColor={tint}
        isInteractive={interactive}
        style={[shape, style]}
      >
        {children}
      </GlassView>
    );
  }
  if (mode === "solid") {
    return (
      <View
        style={[
          shape,
          tint
            ? { backgroundColor: tint }
            : {
                backgroundColor: colors.surface,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
              },
          style,
        ]}
      >
        {children}
      </View>
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
      style={[
        shape,
        { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
        style,
      ]}
    >
      {children}
    </BlurView>
  );
}
