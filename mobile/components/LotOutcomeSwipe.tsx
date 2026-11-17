import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector, RectButton } from "react-native-gesture-handler";
import Animated, {
  ReduceMotion,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import { type LotOutcome, useLotOutcome } from "@/hooks/useLotOutcome";

type LotOutcomeSwipeProps = {
  /** The batches an action records: one batch card, or every batch of a food row. */
  lotIds: string[];
  /** The food's name, shown in the toasts. */
  name: string;
  /** The row or card that slides left to reveal the actions. */
  children: ReactNode;
};

const PILL_WIDTH = 84;
const ACTIONS_WIDTH = PILL_WIDTH * 2;
const PILL_RADIUS = 14;
const HAPTIC_REARM_BELOW_PROGRESS = 0.35;
const DRAG_START_DISTANCE = 10;
const RELEASE_VELOCITY_SHARE = 0.05;
const SNAP_SPRING = {
  mass: 2,
  damping: 1000,
  stiffness: 700,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
};

/**
 * Wraps a food row or batch card so that swiping left reveals "Used up" and
 * "Toss", which record what happened to the batches through
 * {@link useLotOutcome}. Swiping only opens the actions; tapping one commits
 * it, so a long swipe can never pick between them by accident. Tapping the
 * row while it is open closes it.
 *
 * Only the first tap counts: the row stays on screen until the list refetches,
 * and a second record of the same batches would be refused. A failed record
 * closes the swipe and takes taps again.
 *
 * The swipe is built here rather than with gesture-handler's
 * ReanimatedSwipeable, which sets up about a dozen animated values and its
 * action containers for every row it wraps.
 */
export default function LotOutcomeSwipe({ lotIds, name, children }: LotOutcomeSwipeProps) {
  const { record } = useLotOutcome();
  const firedRef = useRef(false);
  const [actionsMounted, setActionsMounted] = useState(false);
  const offset = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const open = useSharedValue(false);

  const snap = useCallback(
    (toOpen: boolean, velocity = 0) => {
      "worklet";
      open.value = toOpen;
      offset.value = withSpring(toOpen ? -ACTIONS_WIDTH : 0, {
        ...SNAP_SPRING,
        velocity,
      });
    },
    [offset, open],
  );

  const gestureId = lotIds.join(",");
  const { pan, tap } = useMemo(() => {
    const mountActions = () => setActionsMounted(true);
    return {
      pan: Gesture.Pan()
        .withTestId(`lot-swipe:${gestureId}`)
        .activeOffsetX([-DRAG_START_DISTANCE, DRAG_START_DISTANCE])
        .onStart(() => {
          dragStart.value = offset.value;
          runOnJS(mountActions)();
        })
        .onUpdate((event) => {
          offset.value = Math.min(
            0,
            Math.max(-ACTIONS_WIDTH, dragStart.value + event.translationX),
          );
        })
        .onEnd((event) => {
          const travel =
            event.translationX + RELEASE_VELOCITY_SHARE * event.velocityX;
          snap(
            open.value ? travel < ACTIONS_WIDTH / 2 : travel < -ACTIONS_WIDTH / 2,
            event.velocityX,
          );
        }),
      tap: Gesture.Tap()
        .shouldCancelWhenOutside(true)
        .onStart(() => {
          if (open.value) snap(false);
        }),
    };
  }, [gestureId, dragStart, offset, open, snap]);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
    pointerEvents: open.value ? "box-only" : "auto",
  }));

  const act = (outcome: LotOutcome) => {
    if (firedRef.current) return;
    firedRef.current = true;
    fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
    record({ lotIds, outcome, name }, () => {
      firedRef.current = false;
      snap(false);
    });
  };

  return (
    <GestureDetector gesture={pan} touchAction="pan-y">
      <View testID="swipe-row" style={styles.container}>
        {actionsMounted ? <Actions offset={offset} onPress={act} /> : null}
        <GestureDetector gesture={tap} touchAction="pan-y">
          <Animated.View style={rowStyle}>{children}</Animated.View>
        </GestureDetector>
      </View>
    </GestureDetector>
  );
}

function Actions({
  offset,
  onPress,
}: {
  offset: SharedValue<number>;
  onPress: (outcome: LotOutcome) => void;
}) {
  const { colors } = useTheme();
  const hiddenWhileClosedStyle = useAnimatedStyle(() => ({
    opacity: offset.value < 0 ? 1 : 0,
  }));

  const openHapticFired = useSharedValue(false);
  useAnimatedReaction(
    () => -offset.value / ACTIONS_WIDTH,
    (current, previous) => {
      if (current >= 1 && (previous ?? 0) < 1 && !openHapticFired.value) {
        openHapticFired.value = true;
        runOnJS(fireHaptic)(Haptics.ImpactFeedbackStyle.Light);
      } else if (current < HAPTIC_REARM_BELOW_PROGRESS) {
        openHapticFired.value = false;
      }
    },
  );

  return (
    <Animated.View style={[styles.actions, hiddenWhileClosedStyle]}>
      <Pill
        label="Used up"
        icon="check"
        background={colors.accent}
        ink={colors.accentInk}
        onPress={() => onPress("used")}
      />
      <Pill
        label="Toss"
        icon="trash"
        background={colors.crit}
        ink="#FFFFFF"
        onPress={() => onPress("tossed")}
      />
    </Animated.View>
  );
}

function Pill({
  label,
  icon,
  background,
  ink,
  onPress,
}: {
  label: string;
  icon: "check" | "trash";
  background: string;
  ink: string;
  onPress: () => void;
}) {
  const { fonts } = useTheme();
  return (
    <View style={{ flex: 1, paddingLeft: 4, paddingRight: 4, paddingVertical: 4 }}>
      <RectButton
        onPress={onPress}
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          flex: 1,
          backgroundColor: background,
          borderRadius: PILL_RADIUS,
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.16,
          shadowRadius: 6,
          elevation: 3,
        }}
      >
        <FontAwesome name={icon} size={18} color={ink} />
        <Text
          style={{
            color: ink,
            fontFamily: fonts.bodyStrong,
            fontSize: 11.5,
            letterSpacing: -0.1,
          }}
        >
          {label}
        </Text>
      </RectButton>
    </View>
  );
}

function fireHaptic(style: Haptics.ImpactFeedbackStyle) {
  Haptics.impactAsync(style).catch(() => {});
}

const styles = StyleSheet.create({
  container: { overflow: "hidden" },
  actions: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: ACTIONS_WIDTH,
    flexDirection: "row",
    paddingLeft: 4,
  },
});
