import { useEffect, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { motionDistance, motionDuration } from "@/constants/motion";

type RecipeSweepExitProps = {
  /**
   * When set, the content leaves: it fades and slides left after this delay,
   * in milliseconds. `undefined` keeps it at rest.
   */
  exitDelayMs: number | undefined;
  /** Fades in place, with no delay or slide. */
  reducedMotion: boolean;
  /** Layout for the wrapper, such as filling a fixed-height slot. */
  style?: StyleProp<ViewStyle>;
  /** The card, and in a carousel slot the slot's dimming too. */
  children: ReactNode;
};

/** Plays a feed card's exit for a "More like this" or "Less like this" sweep. */
export default function RecipeSweepExit({
  exitDelayMs,
  reducedMotion,
  style,
  children,
}: RecipeSweepExitProps) {
  const progress = useSharedValue(0);
  const leaving = exitDelayMs !== undefined;
  useEffect(() => {
    if (exitDelayMs === undefined) {
      progress.value = 0;
      return;
    }
    progress.value = reducedMotion
      ? withTiming(1, { duration: motionDuration.instant })
      : withDelay(
          exitDelayMs,
          withTiming(1, {
            duration: motionDuration.fast,
            easing: Easing.in(Easing.cubic),
          }),
        );
  }, [exitDelayMs, progress, reducedMotion]);
  const animatedStyle = useAnimatedStyle(
    () => ({
      opacity: 1 - progress.value,
      transform: reducedMotion
        ? []
        : [{ translateX: -motionDistance.sweep * progress.value }],
    }),
    [reducedMotion],
  );
  return (
    <Animated.View
      testID={leaving ? "recipe-sweep-leaving" : undefined}
      pointerEvents={leaving ? "none" : "auto"}
      accessibilityElementsHidden={leaving}
      importantForAccessibility={leaving ? "no-hide-descendants" : "auto"}
      style={[style, animatedStyle]}
    >
      {children}
    </Animated.View>
  );
}
