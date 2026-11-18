import { useEffect, useRef, type ReactNode } from "react";
import { Animated, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

const PULSE_HIGH = 0.9;
const PULSE_LOW = 0.45;
const PULSE_STEP_MS = 850;
const STILL_OPACITY = 0.65;

type SkeletonPulseProps = {
  children: ReactNode;
  /** Outer style, such as the size of the area the skeleton holds. */
  style?: StyleProp<ViewStyle>;
};

/**
 * Pulses its children's opacity, or holds it steady when Reduce Motion is on.
 * Hidden from screen readers, so the caller labels the loading region once
 * instead of announcing every placeholder bar.
 */
export function SkeletonPulse({ children, style }: SkeletonPulseProps) {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(STILL_OPACITY)).current;

  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(STILL_OPACITY);
      return;
    }
    const step = (toValue: number) =>
      Animated.timing(opacity, {
        toValue,
        duration: PULSE_STEP_MS,
        useNativeDriver: true,
        isInteraction: false,
      });
    const animation = Animated.loop(Animated.sequence([step(PULSE_HIGH), step(PULSE_LOW)]));
    animation.start();
    return () => animation.stop();
  }, [opacity, reducedMotion]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[style, { opacity }]}
    >
      {children}
    </Animated.View>
  );
}

type SkeletonBarProps = {
  width: DimensionValue;
  /** In points. */
  height: number;
  /** In points. */
  radius?: number;
};

/**
 * Renders one placeholder block in the `border` color, which stays visible on
 * both the page background and card surfaces.
 */
export function SkeletonBar({ width, height, radius = 6 }: SkeletonBarProps) {
  const { colors } = useTheme();
  return (
    <View
      style={{ width, height, borderRadius: radius, backgroundColor: colors.border }}
    />
  );
}
