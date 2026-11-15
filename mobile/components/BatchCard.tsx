import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import UrgencyBar from "@/components/UrgencyBar";
import type { DrawnLot } from "@/lib/foodRows";

type BatchCardProps = {
  /** The batch to show, with its expiry and its place in draw order. */
  batch: DrawnLot;
  /** Called when the card is tapped. */
  onPress: () => void;
};

/**
 * Renders one batch of a food as a card: amount, location, opened state,
 * expiry with an urgency bar, notes, and "Use first" or "Expired" pills.
 */
function BatchCard({ batch, onPress }: BatchCardProps) {
  const { colors, fonts, card } = useTheme();
  const { lot, days, expired, useFirst } = batch;
  const amount = `${formatQuantity(lot.quantity)} ${lot.unit}`;
  const meta = [capitalize(lot.storage_location)];
  if (lot.opened_at !== null) meta.push("Opened");
  const expiry = expiryText(days);
  const expiryColor =
    days === null
      ? colors.textSubtle
      : days < 0
        ? colors.crit
        : days <= 1
          ? colors.warn
          : colors.textMuted;

  const label = [amount, ...meta, expiry];
  if (useFirst) label.push("use first");

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label.join(", ")}
      style={({ pressed }) => ({
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 14,
        gap: 6,
        opacity: pressed ? 0.85 : 1,
        shadowColor: card.shadowColor,
        shadowOffset: card.shadowOffset,
        shadowOpacity: card.shadowOpacity,
        shadowRadius: card.shadowRadius,
        elevation: card.elevation,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          style={{
            flex: 1,
            fontFamily: fonts.bodyStrong,
            fontSize: 15,
            color: colors.text,
            letterSpacing: -0.2,
          }}
        >
          {amount}
        </Text>
        {useFirst ? (
          <Pill label="Use first" color={colors.accent} background={colors.accentSoft} />
        ) : null}
        {expired ? <Pill label="Expired" color={colors.crit} border={colors.crit} /> : null}
      </View>
      <Text style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted }}>
        {meta.join(" · ")}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <UrgencyBar daysUntilExpiration={days} width={92} />
        <Text style={{ fontFamily: fonts.body, fontSize: 12, color: expiryColor }}>{expiry}</Text>
      </View>
      {lot.notes ? (
        <Text
          numberOfLines={1}
          style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textSubtle }}
        >
          {lot.notes}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Pill({
  label,
  color,
  background = "transparent",
  border = "transparent",
}: {
  label: string;
  color: string;
  background?: string;
  border?: string;
}) {
  const { fonts } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 100,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: background,
      }}
    >
      <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 11.5, color, letterSpacing: -0.1 }}>
        {label}
      </Text>
    </View>
  );
}

function expiryText(days: number | null): string {
  if (days === null) return "No expiry date";
  if (days < 0) return `Expired ${Math.abs(days)} day${days === -1 ? "" : "s"} ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(1);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default BatchCard;
