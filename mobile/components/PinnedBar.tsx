import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";

const EDGE_FADE_DISTANCE = 8;
const EDGE_SHADOW = {
  light: "0 8px 18px -12px rgba(0, 0, 0, 0.22)",
  dark: "0 8px 18px -12px rgba(0, 0, 0, 0.7)",
} as const;

type PinnedBarProps = {
  /** The list's vertical scroll offset, in points. */
  scrollY: SharedValue<number>;
  /** Where the bar sits in the list content, in points. */
  top: SharedValue<number>;
  /** The controls to pin. */
  children: ReactNode;
};

/**
 * The background of controls pinned to the top of a list, such as the header
 * {@link PinnedSectionList} pins. A hairline and a soft shadow fade in over
 * the first 8 points that content passes under the bar.
 */
export default function PinnedBar({ scrollY, top, children }: PinnedBarProps) {
  const { colors, colorScheme } = useTheme();
  const edgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value - top.value,
      [0, EDGE_FADE_DISTANCE],
      [0, 1],
      "clamp",
    ),
  }));

  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 10,
        backgroundColor: colors.bg,
      }}
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
    </View>
  );
}
