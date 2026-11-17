import type { ReactNode } from "react";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";

const EDGE_FADE_DISTANCE = 8;
const EDGE_SHADOW = {
  light: "0 8px 18px -12px rgba(0, 0, 0, 0.22)",
  dark: "0 8px 18px -12px rgba(0, 0, 0, 0.7)",
} as const;

type PinnedBarProps = {
  /** The scroll view's vertical offset, in points. */
  scrollY: SharedValue<number>;
  /** Receives the bar's height in points, for content that sticks below it. */
  height: SharedValue<number>;
  /** The controls to pin. */
  children: ReactNode;
};

/**
 * A bar inside a scroll view's content that scrolls with it until it reaches
 * the top, then stays there while the content passes under it. A hairline
 * and a soft shadow fade in over the first 8 points that content passes
 * under the bar. Place it before the content it should cover.
 */
export default function PinnedBar({
  scrollY,
  height,
  children,
}: PinnedBarProps) {
  const { colors, colorScheme } = useTheme();
  const top = useSharedValue(0);
  const pinStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.max(0, scrollY.value - top.value) }],
  }));
  const edgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value - top.value,
      [0, EDGE_FADE_DISTANCE],
      [0, 1],
      "clamp",
    ),
  }));

  return (
    <Animated.View
      onLayout={(event) => {
        top.value = event.nativeEvent.layout.y;
        height.value = event.nativeEvent.layout.height;
      }}
      style={[
        {
          zIndex: 10,
          paddingHorizontal: 16,
          paddingTop: 6,
          paddingBottom: 10,
          backgroundColor: colors.bg,
        },
        pinStyle,
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: colors.bg,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            boxShadow: EDGE_SHADOW[colorScheme],
          },
          edgeStyle,
        ]}
      />
      {children}
    </Animated.View>
  );
}
