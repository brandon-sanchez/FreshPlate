import { memo, useEffect } from "react";
import { Pressable, Text } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import type { ListMotion } from "@/hooks/useListMotion";
import { useTheme } from "@/hooks/useTheme";
import type { FoodSection } from "@/lib/foodRows";
import { TAB_SPRING } from "@/lib/motion";

type InventorySectionHeaderProps = {
  /** The section, with all of its rows even while it is closed. */
  section: FoodSection;
  /** Whether the section's rows show. */
  open: boolean;
  /** Called with the section's key when the header is tapped. */
  onToggle: (key: string) => void;
  /** Shows a Review link in the header when set. */
  onReview?: () => void;
  /** The animations the header enters and leaves with. */
  motion: ListMotion;
};

/**
 * The header of one collapsible inventory section: a chevron that turns as
 * the section opens and closes, the section's name and food count, and an
 * optional Review link.
 */
function InventorySectionHeader({
  section,
  open,
  onToggle,
  onReview,
  motion,
}: InventorySectionHeaderProps) {
  const { colors, fonts } = useTheme();
  const turn = useSharedValue(open ? 90 : 0);
  useEffect(() => {
    turn.value = withSpring(open ? 90 : 0, TAB_SPRING);
  }, [turn, open]);

  const count = section.data.length;
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${turn.value}deg` }],
  }));
  const labelColor =
    section.tone === "crit"
      ? colors.crit
      : section.tone === "warn"
        ? colors.warn
        : colors.textMuted;

  return (
    <Animated.View
      entering={motion.rowEntering(0)}
      exiting={motion.rowExiting}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 8,
        backgroundColor: colors.bg,
      }}
    >
      <Pressable
        onPress={() => onToggle(section.key)}
        accessibilityRole="button"
        accessibilityLabel={`${section.label}, ${count} item${count === 1 ? "" : "s"}`}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 28,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Animated.View style={chevronStyle}>
          <Feather name="chevron-right" size={14} color={colors.textMuted} />
        </Animated.View>
        <Text
          style={{
            fontFamily: fonts.bodyStrong,
            fontSize: 12,
            color: labelColor,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          {section.label}
        </Text>
        <Text
          style={{
            fontFamily: fonts.body,
            fontSize: 11,
            color: colors.textSubtle,
            fontVariant: ["tabular-nums"],
          }}
        >
          {count}
        </Text>
      </Pressable>
      {onReview ? (
        <Pressable
          onPress={onReview}
          hitSlop={12}
          accessibilityRole="link"
          accessibilityLabel="Review expired batches"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 12,
              color: colors.accent,
            }}
          >
            Review
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

export default memo(InventorySectionHeader);
