import type { ComponentProps } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { TAB_SPRING } from "@/lib/motion";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const PRESSED_SCALE = 0.97;
const PRESS_IN_MS = 90;
const REDUCED_PRESSED_OPACITY = 0.7;

type PressableScaleProps = Omit<ComponentProps<typeof Pressable>, "style"> & {
  style?: StyleProp<ViewStyle>;
};

/**
 * A Pressable that shrinks to 97 percent in 90 ms while held and springs
 * back with the tab spring. With Reduce Motion on, it dims instead.
 */
export default function PressableScale({
  onPressIn,
  onPressOut,
  style,
  ...props
}: PressableScaleProps) {
  const reducedMotion = useReducedMotion();
  const pressed = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() =>
    reducedMotion
      ? { opacity: 1 - pressed.value * (1 - REDUCED_PRESSED_OPACITY) }
      : { transform: [{ scale: 1 - pressed.value * (1 - PRESSED_SCALE) }] },
  );
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        pressed.value = withTiming(1, { duration: PRESS_IN_MS });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withSpring(0, TAB_SPRING);
        onPressOut?.(event);
      }}
      style={[style, pressStyle]}
    />
  );
}
