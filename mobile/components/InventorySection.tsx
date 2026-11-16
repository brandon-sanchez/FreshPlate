import { useEffect, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type EntryExitAnimationFunction,
  type LayoutAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import type { FoodSection } from "@/lib/foodRows";
import { TAB_SPRING } from "@/lib/motion";

const ROW_GAP = 6;
const SHADOW_ROOM = 8;
const CHEVRON_SPRING = { ...TAB_SPRING, reduceMotion: ReduceMotion.System };

type InventorySectionProps = {
  /** The section; its `data` is empty while it is closed. */
  section: FoodSection;
  /** How many foods the section holds, open or closed. */
  count: number;
  /** Whether the rows show. */
  open: boolean;
  /** Called when the header is tapped. */
  onToggle: () => void;
  /** Shows a Review link in the header when set. */
  onReview?: () => void;
  /** Renders one row. */
  renderRow: (row: FoodSection["data"][number]) => ReactNode;
  /** The list's scroll offset, in points. */
  scrollY: SharedValue<number>;
  /** Where the list of sections starts in the scroll content, in points. */
  listTop: SharedValue<number>;
  /** The height of the pinned controls the header sticks under, in points. */
  pinHeight: SharedValue<number>;
  /** The layout transition for the section and its rows. */
  layout: LayoutAnimationFunction;
  /** The entering animation for the row at an index. */
  rowEntering: (index: number) => EntryExitAnimationFunction;
  /** The exiting animation for rows. */
  rowExiting: EntryExitAnimationFunction;
};

/**
 * One collapsible inventory section. Its header sticks under the pinned
 * controls while the section scrolls beneath them, and the next section's
 * header pushes it away. The header's chevron turns as the section opens
 * and closes.
 */
export default function InventorySection({
  section,
  count,
  open,
  onToggle,
  onReview,
  renderRow,
  scrollY,
  listTop,
  pinHeight,
  layout,
  rowEntering,
  rowExiting,
}: InventorySectionProps) {
  const { colors, fonts } = useTheme();
  const top = useSharedValue(0);
  const height = useSharedValue(0);
  const headerHeight = useSharedValue(0);
  const turn = useSharedValue(open ? 90 : 0);
  useEffect(() => {
    turn.value = withSpring(open ? 90 : 0, CHEVRON_SPRING);
  }, [turn, open]);

  // Fabric hit-testing drops touches outside a view's laid-out bounds, so the
  // sticky offset is clamped to this section to keep the header tappable.
  const headerStyle = useAnimatedStyle(() => {
    const overlap =
      scrollY.value + pinHeight.value - (listTop.value + top.value);
    const room = Math.max(0, height.value - headerHeight.value);
    return {
      transform: [{ translateY: Math.min(Math.max(overlap, 0), room) }],
    };
  });
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
      layout={layout}
      onLayout={(event) => {
        top.value = event.nativeEvent.layout.y;
        height.value = event.nativeEvent.layout.height;
      }}
    >
      <Animated.View
        onLayout={(event) => {
          headerHeight.value = event.nativeEvent.layout.height;
        }}
        style={[
          {
            zIndex: 2,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingTop: 14,
            paddingBottom: 8,
            backgroundColor: colors.bg,
          },
          headerStyle,
        ]}
      >
        <Pressable
          onPress={onToggle}
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
      <Animated.View
        layout={layout}
        style={{
          overflow: "hidden",
          gap: ROW_GAP,
          marginHorizontal: -SHADOW_ROOM,
          paddingHorizontal: SHADOW_ROOM,
          paddingBottom: open ? SHADOW_ROOM : 0,
        }}
      >
        {section.data.map((row, index) => (
          <Animated.View
            key={row.key}
            layout={layout}
            entering={rowEntering(index)}
            exiting={rowExiting}
          >
            {renderRow(row)}
          </Animated.View>
        ))}
      </Animated.View>
    </Animated.View>
  );
}
