import { useEffect } from "react";
import { Text, View } from "react-native";
import { RectButton } from "react-native-gesture-handler";
import FontAwesome from "@expo/vector-icons/FontAwesome";
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
import UrgencyBar from "@/components/UrgencyBar";
import type { FoodRow } from "@/lib/foodRows";

type InventoryRowProps = {
  /** The food to show, with its lots stacked. A single-lot row reads like one batch. */
  row: FoodRow;
  /** Called with `row` on tap. Without it the row is not pressable. */
  onPress?: (row: FoodRow) => void;
  /** When true, the row pulses with the accent color once to draw the eye. */
  highlight?: boolean;
};

/**
 * Renders one food as an inventory card: name, total amount with batch count
 * and locations, and an urgency bar and label driven by `row.days`.
 */
function InventoryRow({ row, onPress, highlight }: InventoryRowProps) {
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

  const iconName = (row.category?.icon ?? "circle-o") as React.ComponentProps<
    typeof FontAwesome
  >["name"];

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

  return (
    <Animated.View
      style={[
        {
          borderRadius: 14,
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
      <RectButton
        onPress={onPress ? () => onPress(row) : undefined}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilitySummary(row)}
        activeOpacity={1}
        underlayColor="transparent"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 12,
        }}
      >
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            backgroundColor: colors.surfaceAlt,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FontAwesome name={iconName} size={22} color={colors.textMuted} />
        </View>

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
      </RectButton>
    </Animated.View>
  );
}

function metaLine(row: FoodRow): string {
  const parts = [`${formatQuantity(row.total)} ${row.unit}`];
  if (row.lots.length > 1) parts.push(`${row.lots.length} batches`);
  parts.push(row.locations.map(capitalize).join(", "));
  if (row.isLeftover) parts.push("Leftover");
  const hidden = hiddenExpiredLots(row);
  if (hidden > 0) parts.push(`${hidden} expired`);
  return parts.join(" · ");
}

function accessibilitySummary(row: FoodRow): string {
  const parts = [row.name, `${formatQuantity(row.total)} ${row.unit}`];
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

function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(1);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default InventoryRow;
