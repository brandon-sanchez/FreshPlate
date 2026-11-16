import { Pressable, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import SegmentedControl from "@/components/SegmentedControl";
import { useTheme } from "@/hooks/useTheme";
import { GROUP_BYS, type GroupBy } from "@/lib/foodRows";
import { sortLabel, type SortBy } from "@/lib/foodSort";

const LABEL_COLUMN_MIN_WIDTH = 52;

type InventoryViewControlsProps = {
  /** The grouping whose tab is selected. */
  groupBy: GroupBy;
  /** Called with the tapped grouping tab. */
  onGroupByChange: (groupBy: GroupBy) => void;
  /** The sort the pill names. */
  sortBy: SortBy;
  /** Called when the sort pill is tapped, to show the sort options. */
  onSortPress: () => void;
};

/** The Group by tabs and the sort pill above the inventory list. */
export default function InventoryViewControls({
  groupBy,
  onGroupByChange,
  sortBy,
  onSortPress,
}: InventoryViewControlsProps) {
  const { colors, fonts } = useTheme();
  const label = sortLabel(sortBy);

  return (
    <View style={{ gap: 8, marginTop: 14, marginBottom: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ControlLabel text="Group by" />
        <View style={{ flex: 1 }}>
          <SegmentedControl
            role="tab"
            options={GROUP_BYS}
            selected={groupBy}
            onSelect={onGroupByChange}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ControlLabel text="Sort" />
        <Pressable
          onPress={onSortPress}
          hitSlop={{ top: 4, bottom: 4 }}
          accessibilityRole="button"
          accessibilityLabel={`Sort, ${label}`}
          accessibilityHint="Shows the sort options"
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 36,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 12,
            backgroundColor: colors.surfaceAlt,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <FontAwesome
            name="sort-amount-asc"
            size={12}
            color={colors.textMuted}
          />
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 13,
              color: colors.text,
              letterSpacing: -0.1,
            }}
          >
            {label}
          </Text>
          <FontAwesome name="angle-down" size={14} color={colors.textMuted} />
        </Pressable>
      </View>
    </View>
  );
}

function ControlLabel({ text }: { text: string }) {
  const { colors, fonts } = useTheme();
  return (
    <Text
      style={{
        minWidth: LABEL_COLUMN_MIN_WIDTH,
        fontFamily: fonts.body,
        fontSize: 11,
        color: colors.textSubtle,
      }}
    >
      {text}
    </Text>
  );
}
