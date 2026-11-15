import { type ReactNode, useRef } from "react";
import { Text, View } from "react-native";
import { RectButton } from "react-native-gesture-handler";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import {
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useSharedValue,
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

/* ReanimatedSwipeable needs a fixed action width; `flex: 1` leaves the
 * snap-open animation without an anchor and the swipe stalls mid-drag. */
const PILL_WIDTH = 84;
const ACTIONS_WIDTH = PILL_WIDTH * 2;
const PILL_RADIUS = 14;
const HAPTIC_REARM_BELOW_PROGRESS = 0.35;

/**
 * Wraps a food row or batch card so that swiping left reveals "Used up" and
 * "Toss", which record what happened to the batches through
 * {@link useLotOutcome}. Swiping only opens the actions; tapping one commits
 * it, so a long swipe can never pick between them by accident.
 *
 * Only the first tap counts: the row stays on screen until the list refetches,
 * and a second record of the same batches would be refused. A failed record
 * closes the swipe and takes taps again.
 */
export default function LotOutcomeSwipe({ lotIds, name, children }: LotOutcomeSwipeProps) {
  const { record } = useLotOutcome();
  const swipeRef = useRef<SwipeableMethods>(null);
  const firedRef = useRef(false);

  const act = (outcome: LotOutcome) => {
    if (firedRef.current) return;
    firedRef.current = true;
    fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
    record({ lotIds, outcome, name }, () => {
      firedRef.current = false;
      swipeRef.current?.close();
    });
  };

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={1}
      rightThreshold={ACTIONS_WIDTH / 2}
      overshootRight={false}
      renderRightActions={(progress) => <Actions progress={progress} onPress={act} />}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

function Actions({
  progress,
  onPress,
}: {
  progress: SharedValue<number>;
  onPress: (outcome: LotOutcome) => void;
}) {
  const { colors } = useTheme();

  const openHapticFired = useSharedValue(false);
  useAnimatedReaction(
    () => progress.value,
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
    <View style={{ width: ACTIONS_WIDTH, flexDirection: "row", paddingLeft: 4 }}>
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
    </View>
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
