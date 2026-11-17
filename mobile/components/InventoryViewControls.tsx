import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  Pressable,
  Text,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Ionicons from "@expo/vector-icons/Ionicons";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutUp,
  interpolateColor,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import SegmentedControl from "@/components/SegmentedControl";
import SortFilterMenu from "@/components/SortFilterMenu";
import PressableScale from "@/components/PressableScale";
import { useTheme } from "@/hooks/useTheme";
import type { WindowRect } from "@/lib/anchoredFrame";
import { GROUP_BYS, type GroupBy } from "@/lib/foodRows";
import { sortSummary, type SortBy } from "@/lib/foodSort";
import {
  countActiveFilters,
  describeFilters,
  EMPTY_FILTERS,
  type FilterChoices,
  type InventoryFilters,
} from "@/lib/inventoryFilters";
import { MENU_SPRING, REDUCED_FADE_MS } from "@/lib/motion";

const BUTTON_SIZE = 45;
const BADGE_IN = ZoomIn.springify()
  .stiffness(MENU_SPRING.stiffness)
  .damping(MENU_SPRING.damping)
  .mass(MENU_SPRING.mass);
const REDUCED_IN = FadeIn.duration(REDUCED_FADE_MS);
const REDUCED_OUT = FadeOut.duration(REDUCED_FADE_MS);

type InventoryViewControlsProps = {
  /** The grouping whose tab is selected. */
  groupBy: GroupBy;
  /** Called with the tapped grouping tab. */
  onGroupByChange: (groupBy: GroupBy) => void;
  /** The selected sort. */
  sortBy: SortBy;
  /** Called with the sort picked in the menu. */
  onSortChange: (sortBy: SortBy) => void;
  /** The active filters. */
  filters: InventoryFilters;
  /** Called with an update to apply to the filters. */
  onFiltersChange: (
    update: (current: InventoryFilters) => InventoryFilters,
  ) => void;
  /** The places and categories the menu offers, from `filterOptions`. */
  options: FilterChoices;
  /** How many foods the household has, for the summary line when nothing is filtered. */
  totalCount: number;
};

/**
 * The controls pinned above the inventory list: the Group by tabs, a Sort
 * and filter button that opens {@link SortFilterMenu}, and a line stating the
 * sort and filters with a Clear link. The button fills with the accent color
 * and shows a count while filters are on.
 */
export default function InventoryViewControls({
  groupBy,
  onGroupByChange,
  sortBy,
  onSortChange,
  filters,
  onFiltersChange,
  options,
  totalCount,
}: InventoryViewControlsProps) {
  const { colors, fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  const trigger = useRef<View>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<WindowRect | null>(null);
  const active = countActiveFilters(filters);
  const parts = describeFilters(filters, options);
  const summary = [
    sortSummary(sortBy),
    ...(parts.length > 0
      ? parts
      : [`all ${totalCount} item${totalCount === 1 ? "" : "s"}`]),
  ].join(" · ");

  const openMenu = () => {
    Keyboard.dismiss();
    trigger.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setMenuOpen(true);
    });
  };
  const closeMenu = () => {
    setMenuOpen(false);
    if (trigger.current)
      AccessibilityInfo.sendAccessibilityEvent(trigger.current, "focus");
  };

  return (
    <LayoutAnimationConfig skipEntering>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <SegmentedControl
            role="tab"
            options={GROUP_BYS}
            selected={groupBy}
            onSelect={onGroupByChange}
          />
        </View>
        <View ref={trigger} collapsable={false}>
          <FilterButton
            active={active}
            expanded={menuOpen}
            onPress={openMenu}
            reducedMotion={reducedMotion}
          />
        </View>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginTop: 8,
          minHeight: 28,
        }}
      >
        <Pressable
          onPress={openMenu}
          accessibilityRole="button"
          accessibilityLabel={summary}
          accessibilityHint="Opens sort and filter"
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
            minHeight: 28,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Ionicons name="swap-vertical" size={13} color={colors.textMuted} />
          <View style={{ flex: 1, overflow: "hidden" }}>
            <Animated.Text
              key={summary}
              entering={reducedMotion ? REDUCED_IN : FadeInDown.duration(200)}
              exiting={reducedMotion ? REDUCED_OUT : FadeOutUp.duration(120)}
              numberOfLines={1}
              style={{
                fontFamily: fonts.body,
                fontSize: 12.5,
                color: colors.textMuted,
              }}
            >
              {summary}
            </Animated.Text>
          </View>
        </Pressable>
        {active > 0 ? (
          <Animated.View entering={REDUCED_IN} exiting={REDUCED_OUT}>
            <Pressable
              onPress={() => onFiltersChange(() => EMPTY_FILTERS)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Clear filters"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  fontSize: 13,
                  color: colors.accent,
                }}
              >
                Clear
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </View>
      <SortFilterMenu
        open={menuOpen}
        anchor={anchor}
        sortBy={sortBy}
        onSortChange={onSortChange}
        filters={filters}
        onFiltersChange={onFiltersChange}
        options={options}
        onClose={closeMenu}
      />
    </LayoutAnimationConfig>
  );
}

function FilterButton({
  active,
  expanded,
  onPress,
  reducedMotion,
}: {
  active: number;
  expanded: boolean;
  onPress: () => void;
  reducedMotion: boolean;
}) {
  const { colors, fonts } = useTheme();
  const fill = useSharedValue(active > 0 ? 1 : 0);
  useEffect(() => {
    fill.value = withTiming(active > 0 ? 1 : 0, { duration: REDUCED_FADE_MS });
  }, [fill, active]);
  const fillStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      fill.value,
      [0, 1],
      [colors.surfaceAlt, colors.accent],
    ),
  }));

  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Sort and filter"
      accessibilityValue={
        active > 0
          ? { text: `${active} filter${active === 1 ? "" : "s"} on` }
          : undefined
      }
      accessibilityState={{ expanded }}
    >
      <Animated.View
        style={[
          {
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
          },
          fillStyle,
        ]}
      >
        <Feather
          name="sliders"
          size={17}
          color={active > 0 ? colors.accentInk : colors.textMuted}
        />
      </Animated.View>
      {active > 0 ? (
        <Animated.View
          entering={reducedMotion ? REDUCED_IN : BADGE_IN}
          exiting={reducedMotion ? REDUCED_OUT : ZoomOut.duration(120)}
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -5,
            right: -5,
            minWidth: 18,
            height: 18,
            paddingHorizontal: 5,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.crit,
            boxShadow: `0 0 0 2px ${colors.bg}`,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 11,
              color: "#FFFFFF",
              fontVariant: ["tabular-nums"],
            }}
          >
            {active}
          </Text>
        </Animated.View>
      ) : null}
    </PressableScale>
  );
}
