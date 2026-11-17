import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import Feather from "@expo/vector-icons/Feather";
import Ionicons from "@expo/vector-icons/Ionicons";
import { motionDuration, motionScale, motionSpring } from "@/constants/motion";
import { useTheme } from "@/hooks/useTheme";

/** What a right swipe does, shown behind the card and spoken by screen readers. */
export const SWIPE_COOK_LABEL = "Cook this";
/** What a left swipe does, shown behind the card and spoken by screen readers. */
export const SWIPE_DISCARD_LABEL = "Not this";

const SWIPE_COMMIT_DISTANCE = 96;
const SWIPE_COMMIT_VELOCITY = 800;
const FLICK_MIN_DISTANCE = 32;
const ACTIVE_OFFSET_X = 24;
const FAIL_OFFSET_Y = 16;
const TILT_DEGREES_PER_SCREEN_WIDTH = 6;

type RecipeCardSwipeProps = {
  /** Names the pan gesture in tests: `recipe-card-swipe-<testKey>`. */
  testKey: string;
  /** Fades instead of throwing the card, with no tilt or press pulse. */
  reducedMotion: boolean;
  /** Called on a committed right swipe, after the card starts springing back. */
  onCook: () => void;
  /** Called on a committed left swipe, once the card has left the screen. */
  onDiscard: () => void;
  /** The card. */
  children: ReactNode;
};

/**
 * Lets a feed card be swiped sideways. The card follows a horizontal drag
 * with a slight tilt while vertical drags stay with the feed's scroll.
 *
 * A swipe commits when it is released past its commit distance, or flicked
 * the way it moved. A committed left swipe throws the card off the screen,
 * then calls `onDiscard`, and ignores any touch on the card until then. A
 * committed right swipe springs the card back with a short press pulse and
 * calls `onCook`. Any other swipe springs back and does nothing. "Cook this"
 * and "Not this" panels fade in behind the card as it moves, and a light
 * haptic marks the point where letting go commits.
 */
export default function RecipeCardSwipe({
  testKey,
  reducedMotion,
  onCook,
  onDiscard,
  children,
}: RecipeCardSwipeProps) {
  const { colors, fonts } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(1);
  const scale = useSharedValue(1);
  const leaving = useSharedValue(false);
  // The feed passes new callbacks on most renders. Reading them through refs
  // keeps one gesture for the card's life, so a render mid-drag never swaps
  // the handler under the finger.
  const onCookRef = useRef(onCook);
  const onDiscardRef = useRef(onDiscard);
  useLayoutEffect(() => {
    onCookRef.current = onCook;
    onDiscardRef.current = onDiscard;
  }, [onCook, onDiscard]);
  const pan = useMemo(() => {
    const cook = () => onCookRef.current();
    const discard = () => onDiscardRef.current();
    return Gesture.Pan()
      .withTestId(`recipe-card-swipe-${testKey}`)
      .activeOffsetX([-ACTIVE_OFFSET_X, ACTIVE_OFFSET_X])
      .failOffsetY([-FAIL_OFFSET_Y, FAIL_OFFSET_Y])
      .onUpdate(({ translationX }) => {
        if (!leaving.value) translateX.value = translationX;
      })
      .onEnd(({ translationX, velocityX }, success) => {
        if (leaving.value) return;
        const direction = success
          ? committedSwipeDirection(translationX, velocityX)
          : null;
        if (direction === "left") {
          leaving.value = true;
          const done = (finished?: boolean) => {
            if (finished) runOnJS(discard)();
          };
          if (reducedMotion) {
            opacity.value = withTiming(
              0,
              { duration: motionDuration.instant },
              done,
            );
            return;
          }
          const throwTiming = {
            duration: motionDuration.throw,
            easing: Easing.out(Easing.cubic),
          };
          translateX.value = withTiming(-screenWidth, throwTiming, done);
          opacity.value = withTiming(0, throwTiming);
          return;
        }
        translateX.value = withSpring(0, motionSpring.snappy);
        if (direction !== "right") return;
        if (!reducedMotion) {
          scale.value = withSequence(
            withTiming(motionScale.press, { duration: motionDuration.instant }),
            withSpring(1, motionSpring.snappy),
          );
        }
        runOnJS(confirmHaptic)();
        runOnJS(cook)();
      });
  }, [
    leaving,
    opacity,
    reducedMotion,
    scale,
    screenWidth,
    testKey,
    translateX,
  ]);
  useAnimatedReaction(
    () => Math.abs(translateX.value) >= SWIPE_COMMIT_DISTANCE,
    (past, wasPast) => {
      if (past && wasPast === false && !leaving.value) {
        runOnJS(thresholdHaptic)();
      }
    },
  );
  const cardStyle = useAnimatedStyle(
    () => ({
      opacity: opacity.value,
      transform: [
        { translateX: translateX.value },
        {
          rotate: reducedMotion
            ? "0deg"
            : `${(translateX.value / screenWidth) * TILT_DEGREES_PER_SCREEN_WIDTH}deg`,
        },
        { scale: scale.value },
      ],
    }),
    [reducedMotion, screenWidth],
  );
  const cookRevealStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateX.value,
      [0, SWIPE_COMMIT_DISTANCE],
      [0, 1],
      "clamp",
    ),
  }));
  const discardRevealStyle = useAnimatedStyle(() => ({
    opacity:
      opacity.value *
      interpolate(
        translateX.value,
        [-SWIPE_COMMIT_DISTANCE, 0],
        [1, 0],
        "clamp",
      ),
  }));
  const labelStyle = { fontFamily: fonts.bodyStrong, fontSize: 15 };
  return (
    <GestureDetector gesture={pan}>
      <View>
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.reveal,
            styles.cookReveal,
            { backgroundColor: colors.accent },
            cookRevealStyle,
          ]}
        >
          <Ionicons name="flame" size={23} color={colors.accentInk} />
          <Text style={[labelStyle, { color: colors.accentInk }]}>
            {SWIPE_COOK_LABEL}
          </Text>
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.reveal,
            styles.discardReveal,
            { backgroundColor: colors.surfaceAlt },
            discardRevealStyle,
          ]}
        >
          <Text style={[labelStyle, { color: colors.text }]}>
            {SWIPE_DISCARD_LABEL}
          </Text>
          <Feather name="x" size={22} color={colors.text} />
        </Animated.View>
        <Animated.View style={cardStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

/**
 * Returns the side a released swipe commits to, or `null` to spring back. A
 * fast release against the swipe's direction cancels even a long swipe.
 */
function committedSwipeDirection(
  translationX: number,
  velocityX: number,
): "left" | "right" | null {
  "worklet";
  const fast = Math.abs(velocityX) >= SWIPE_COMMIT_VELOCITY;
  const sameWay = Math.sign(velocityX) === Math.sign(translationX);
  if (fast && !sameWay) return null;
  const flicked = fast && Math.abs(translationX) >= FLICK_MIN_DISTANCE;
  if (!flicked && Math.abs(translationX) < SWIPE_COMMIT_DISTANCE) return null;
  return translationX < 0 ? "left" : "right";
}

function thresholdHaptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

function confirmHaptic() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
    () => {},
  );
}

const styles = StyleSheet.create({
  reveal: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 24,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cookReveal: { paddingLeft: 28 },
  discardReveal: { justifyContent: "flex-end", paddingRight: 28 },
});
