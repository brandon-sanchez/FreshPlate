import { Pressable, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import { getUrgency } from "@/constants/theme";
import UrgencyBar from "@/components/UrgencyBar";
import { daysUntilExpiration, InventoryItem } from "@/hooks/useInventoryItems";

type InventoryRowProps = {
  item: InventoryItem;
  onPress?: (item: InventoryItem) => void;
};

function InventoryRow({ item, onPress }: InventoryRowProps) {
  const { colors, fonts, card } = useTheme();
  const days = daysUntilExpiration(item.expiration_date);
  const urgencyLabel = days === null ? null : getUrgency(days).label;
  const labelColor =
    days === null
      ? colors.textSubtle
      : days < 0
        ? colors.crit
        : days <= 1
          ? colors.warn
          : colors.textMuted;

  const iconName = (item.category?.icon ?? "circle-o") as React.ComponentProps<
    typeof FontAwesome
  >["name"];

  return (
    <Pressable
      onPress={onPress ? () => onPress(item) : undefined}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        backgroundColor: colors.surface,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        shadowColor: card.shadowColor,
        shadowOffset: card.shadowOffset,
        shadowOpacity: card.shadowOpacity,
        shadowRadius: card.shadowRadius,
        elevation: card.elevation,
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
          {item.name}
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
          {formatQuantity(item.quantity)} {item.unit} ·{" "}
          {capitalize(item.storage_location)}
          {item.is_leftover ? " · Leftover" : ""}
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
    </Pressable>
  );
}

function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(1);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default InventoryRow;
