import { useEffect, useRef } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import Feather from "@expo/vector-icons/Feather";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { RecipePressable } from "@/components/recipe-motion";
import { motionDuration, motionScale, motionSpring } from "@/constants/motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

const ON_PHOTO_FILL = "rgba(255,255,255,0.92)";
const ON_PHOTO_INK = "#1B1F1C";
const ICON_SIZE = 19;

type RecipeSaveButtonProps = {
  /** Whether the recipe is in the household cookbook. */
  saved: boolean;
  /** The recipe title, used in the screen reader label. */
  title: string;
  /** Blocks presses while a save or unsave is in flight. */
  disabled: boolean;
  /** The caller flips `saved` in response, which runs the animation. */
  onPress: () => void;
  /**
   * `pill` shows the bookmark with a "Save" or "Saved" label, for the feed
   * card. `round` shows the bookmark alone in a circle, for the detail hero.
   */
  variant: "pill" | "round";
  /** Test id for the pressable. */
  testID?: string;
  /** Position within the parent, such as absolute offsets. */
  style?: StyleProp<ViewStyle>;
};

/**
 * Renders the bookmark toggle for a recipe. When `saved` changes after a
 * press, the bookmark cross-fades between outline and filled, and a save
 * also springs the icon from slightly smaller back to full size. With Reduce
 * Motion on, only a short fade remains. Other changes to `saved` show the
 * new state at once. A press plays a light haptic tap.
 */
export default function RecipeSaveButton({
  saved,
  title,
  disabled,
  onPress,
  variant,
  testID,
  style,
}: RecipeSaveButtonProps) {
  const { colors, fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(saved ? 1 : 0);
  const iconScale = useSharedValue(1);
  const previousSaved = useRef(saved);
  const pressedSinceChange = useRef(false);

  useEffect(() => {
    if (previousSaved.current === saved) return;
    previousSaved.current = saved;
    const target = saved ? 1 : 0;
    // A change the user didn't make here, such as the saved list loading or
    // another household member's save, shows the new state without motion.
    const fromPress = pressedSinceChange.current;
    pressedSinceChange.current = false;
    if (!fromPress) {
      progress.value = target;
      return;
    }
    if (reducedMotion) {
      progress.value = withTiming(target, { duration: motionDuration.instant });
      return;
    }
    progress.value = withTiming(target, { duration: motionDuration.fast });
    if (saved) {
      iconScale.value = withSequence(
        withTiming(motionScale.toggle, { duration: motionDuration.instant }),
        withSpring(1, motionSpring.snappy),
      );
    }
  }, [iconScale, progress, reducedMotion, saved]);

  const round = variant === "round";
  const restingInk = round ? ON_PHOTO_INK : colors.textMuted;
  const savedInk = round ? colors.accentInk : colors.accent;
  const restingFill = round ? ON_PHOTO_FILL : colors.surface;
  const savedFill = round ? colors.accent : colors.surface;

  const fillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [restingFill, savedFill],
    ),
  }));
  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));
  const outlineStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
  }));
  const filledStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(progress.value, [0, 1], [restingInk, savedInk]),
  }));

  return (
    <RecipePressable
      onPress={() => {
        pressedSinceChange.current = true;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={
        saved
          ? `Remove ${title} from saved recipes`
          : `Save ${title} to household cookbook`
      }
      accessibilityState={{ selected: saved, disabled }}
      testID={testID}
      style={[
        round ? styles.round : styles.pill,
        round && disabled && styles.pending,
        style,
      ]}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.fill, fillStyle]}
      />
      <Animated.View style={[styles.icon, iconStyle]}>
        <Animated.View style={[styles.glyph, outlineStyle]}>
          <Feather name="bookmark" size={ICON_SIZE} color={restingInk} />
        </Animated.View>
        <Animated.View style={[styles.glyph, filledStyle]}>
          <FontAwesome name="bookmark" size={ICON_SIZE} color={savedInk} />
        </Animated.View>
      </Animated.View>
      {!round && (
        <Animated.Text
          style={[{ fontFamily: fonts.bodyStrong, fontSize: 12 }, labelStyle]}
        >
          {saved ? "Saved" : "Save"}
        </Animated.Text>
      )}
    </RecipePressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 44,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  round: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  pending: { opacity: 0.6 },
  fill: { borderRadius: 22 },
  icon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  glyph: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
});
