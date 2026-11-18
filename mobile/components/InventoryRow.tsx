import { useEffect } from "react";
import { Platform, Text, View } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import { getUrgency } from "@/constants/theme";
import { RecipePressable } from "@/components/recipe-motion";
import UrgencyBar from "@/components/UrgencyBar";
import FoodPhoto, { FOOD_PHOTO_RADIUS_RATIO } from "@/components/food-photo";
import { SkeletonBar } from "@/components/skeleton";
import type { FoodRow } from "@/lib/foodRows";
import { formatAmount } from "@/lib/amount";

const PHOTO_SIZE = 48;
const ROW_CONTENT_STYLE = {
  flexDirection: "row",
  alignItems: "center",
  gap: 12,
  padding: 12,
} as const;

type InventoryRowProps = {
  /** The food to show, with its lots stacked. A single-lot row reads like one batch. */
  row: FoodRow;
  /** Called with `row` on tap. Without it the row is not pressable. */
  onPress?: (row: FoodRow) => void;
  /** When true, the row pulses with the accent color once to draw the eye. */
  highlight?: boolean;
  /**
   * Whether to request the food's photo. The first request may start a paid
   * generation, so pass `false` for a row that is not on screen yet; the
   * category icon shows instead.
   */
  photoEnabled: boolean;
};

// Holds the press shrink back briefly, so a scroll that starts on a row
// does not shrink and spring the card.
const PRESS_FEEDBACK_DELAY_MS = 100;
const CARD_RADIUS = 14;
// Android draws a foreground ripple over the pressable's whole box, so the
// box is rounded and clipped there to keep the ripple inside the card's
// corners. iOS has no ripple and keeps the card's pulse unclipped.
const ANDROID_RIPPLE_CLIP =
  Platform.OS === "android"
    ? { borderRadius: CARD_RADIUS, overflow: "hidden" as const }
    : undefined;

/**
 * Renders one food as an inventory card: the food's photo, name, total
 * amount with batch count and locations, and an urgency bar and label driven
 * by `row.days`. The category icon stands in until the photo loads.
 */
function InventoryRow({
  row,
  onPress,
  highlight,
  photoEnabled,
}: InventoryRowProps) {
  const { colors, fonts, card } = useTheme();
  const { days } = row;
  const urgencyLabel = days === null ? null : getUrgency(days).label;
  const labelColor =
    days === null
      ? colors.textSubtle
      : days < 0
        ? colors.crit
        : days <= 1
          ? colors.warn
          : colors.textMuted;

  // Highlight pulse: ramp in 200ms, hold 600ms, ramp out 700ms — total ~1.5s.
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (!highlight) return;
    pulse.value = 0;
    pulse.value = withSequence(
      withTiming(1, { duration: 200 }),
      withDelay(600, withTiming(0, { duration: 700 })),
    );
  }, [highlight, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      pulse.value,
      [0, 1],
      [colors.border, colors.accent],
    ),
    backgroundColor: interpolateColor(
      pulse.value,
      [0, 1],
      [colors.surface, colors.accentSoft],
    ),
    transform: [{ scale: 1 + pulse.value * 0.012 }],
  }));

  // A JS Pressable rather than a gesture-handler RectButton: inside
  // LotOutcomeSwipe, the swipeable's tap gesture keeps a RectButton's onPress
  // from firing on iOS, so the row would not open.
  return (
    <RecipePressable
      unstable_pressDelay={PRESS_FEEDBACK_DELAY_MS}
      onPress={onPress ? () => onPress(row) : undefined}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilitySummary(row)}
      android_ripple={{ color: colors.border, foreground: true }}
      style={ANDROID_RIPPLE_CLIP}
    >
      <Animated.View
        style={[
          {
            borderRadius: CARD_RADIUS,
            borderWidth: 1,
            overflow: "hidden",
            shadowColor: card.shadowColor,
            shadowOffset: card.shadowOffset,
            shadowOpacity: card.shadowOpacity,
            shadowRadius: card.shadowRadius,
            elevation: card.elevation,
          },
          animatedStyle,
        ]}
      >
        <View style={ROW_CONTENT_STYLE}>
          <FoodPhoto
            foodId={row.foodId}
            size={PHOTO_SIZE}
            icon={row.category?.icon}
            enabled={photoEnabled}
          />

          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text
              numberOfLines={1}
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 15,
                color: colors.text,
                letterSpacing: -0.2,
              }}
            >
              {row.name}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                fontFamily: fonts.body,
                fontSize: 12.5,
                color: colors.textMuted,
                letterSpacing: -0.05,
              }}
            >
              {metaLine(row)}
            </Text>
            <UrgencyBar daysUntilExpiration={days} width={92} />
          </View>

          {urgencyLabel ? (
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 11,
                color: labelColor,
                letterSpacing: 0.4,
                textTransform: "uppercase",
              }}
            >
              {urgencyLabel}
            </Text>
          ) : null}
        </View>
      </Animated.View>
    </RecipePressable>
  );
}

/**
 * Renders a placeholder with an inventory row's size and shape: a photo block
 * and two text bars. Wrap it in `SkeletonPulse` to animate it.
 */
export function InventoryRowSkeleton() {
  const { colors } = useTheme();
  return (
    <View
      style={[
        ROW_CONTENT_STYLE,
        {
          borderRadius: CARD_RADIUS,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
      ]}
    >
      <SkeletonBar
        width={PHOTO_SIZE}
        height={PHOTO_SIZE}
        radius={PHOTO_SIZE * FOOD_PHOTO_RADIUS_RATIO}
      />
      <View style={{ flex: 1, gap: 8 }}>
        <SkeletonBar width="45%" height={13} />
        <SkeletonBar width="62%" height={10} />
      </View>
    </View>
  );
}

function metaLine(row: FoodRow): string {
  const parts = [formatAmount(row.total, row.unit, row.isEstimate)];
  if (row.lots.length > 1) parts.push(`${row.lots.length} batches`);
  parts.push(row.locations.map(capitalize).join(", "));
  if (row.isLeftover) parts.push("Leftover");
  const hidden = hiddenExpiredLots(row);
  if (hidden > 0) parts.push(`${hidden} expired`);
  return parts.join(" · ");
}

function accessibilitySummary(row: FoodRow): string {
  const parts = [row.name, formatAmount(row.total, row.unit, row.isEstimate)];
  if (row.lots.length > 1) parts.push(`${row.lots.length} batches`);
  parts.push(expirySummary(row.days));
  const hidden = hiddenExpiredLots(row);
  if (hidden > 0) parts.push(`${hidden} expired`);
  return parts.join(", ");
}

/** Expired lots the urgency label does not already announce. */
function hiddenExpiredLots(row: FoodRow): number {
  return row.urgency === "expired" ? 0 : row.expiredLots;
}

function expirySummary(days: number | null): string {
  if (days === null) return "no expiry date";
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default InventoryRow;
