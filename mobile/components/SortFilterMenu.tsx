import { useEffect, useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  CheckRow,
  Disclosure,
  MENU_ROW_HEIGHT,
  MenuHeading,
  menuPalette,
  SortRow,
  SwitchRow,
} from "@/components/SortFilterMenuRows";
import PressableScale from "@/components/PressableScale";
import { useTheme } from "@/hooks/useTheme";
import {
  nextSort,
  SORT_FAMILIES,
  sortDirection,
  type SortBy,
} from "@/lib/foodSort";
import {
  countActiveFilters,
  EMPTY_FILTERS,
  type FilterOption,
  type filterOptions,
  type InventoryFilters,
} from "@/lib/inventoryFilters";
import { MENU_CLOSE_MS, MENU_SPRING, TAB_SPRING } from "@/lib/motion";

const MENU_WIDTH = 284;
const EDGE = 8;
const GAP_BELOW_ANCHOR = 6;
const BOTTOM_MARGIN = 14;
const OPEN_FADE_MS = 120;

/** Where the menu's trigger sits on screen, in window points. */
export type MenuAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SortFilterMenuProps = {
  /** Whether the menu is showing. It animates out before it unmounts. */
  open: boolean;
  /** The trigger the menu hangs from; `null` until the trigger is measured. */
  anchor: MenuAnchor | null;
  /** The selected sort. */
  sortBy: SortBy;
  /** Called with the sort a tap picks; tapping the selected family flips it. */
  onSortChange: (sortBy: SortBy) => void;
  /** The active filters. */
  filters: InventoryFilters;
  /** Called with an update to apply to the filters; filters apply as they change. */
  onFiltersChange: (
    update: (current: InventoryFilters) => InventoryFilters,
  ) => void;
  /** The places and categories to offer, with their food counts. */
  options: ReturnType<typeof filterOptions>;
  /** Called when the menu asks to close: Done, a tap outside, or the back gesture. */
  onClose: () => void;
};

/**
 * The Inventory screen's Sort and filter dropdown. It hangs under its
 * trigger, opens with a slight spring from 90 percent scale and closes with
 * a short fade. It lists the sort families, then expandable Location and
 * Category lists and two switches. Every choice applies at once. With
 * Reduce Motion on, it only fades.
 */
export default function SortFilterMenu({
  open,
  anchor,
  sortBy,
  onSortChange,
  filters,
  onFiltersChange,
  options,
  onClose,
}: SortFilterMenuProps) {
  const { colors, fonts, colorScheme } = useTheme();
  const palette = menuPalette(colorScheme);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (open) {
      setMounted(true);
      opacity.value = withTiming(1, { duration: OPEN_FADE_MS });
      scale.value = reducedMotion ? 1 : 0.9;
      if (!reducedMotion) scale.value = withSpring(1, MENU_SPRING);
      return;
    }
    const easing = Easing.in(Easing.quad);
    if (!reducedMotion)
      scale.value = withTiming(0.96, { duration: MENU_CLOSE_MS, easing });
    opacity.value = withTiming(
      0,
      { duration: MENU_CLOSE_MS, easing },
      (finished) => {
        if (finished) runOnJS(setMounted)(false);
      },
    );
  }, [open, opacity, scale, reducedMotion]);

  const menuStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (!mounted || !anchor) return null;

  const width = Math.min(MENU_WIDTH, window.width - EDGE * 2);
  const left = Math.max(
    EDGE,
    Math.min(anchor.x + anchor.width - width, window.width - width - EDGE),
  );
  const top = anchor.y + anchor.height + GAP_BELOW_ANCHOR;
  const maxHeight =
    window.height -
    top -
    Math.max(insets.bottom, BOTTOM_MARGIN) -
    BOTTOM_MARGIN;
  const originX = Math.max(
    14,
    Math.min(anchor.x + anchor.width / 2 - left, width - 14),
  );
  const active = countActiveFilters(filters);
  const current = sortDirection(sortBy);
  const selectedIndex = SORT_FAMILIES.findIndex(
    (family) => family.key === current.family,
  );

  const toggleIn = <T extends string>(list: T[], value: T) =>
    list.includes(value)
      ? list.filter((item) => item !== value)
      : [...list, value];

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Animated.View
        style={[{ flex: 1, backgroundColor: palette.scrim }, scrimStyle]}
      >
        <Pressable
          onPressIn={onClose}
          accessibilityLabel="Close sort and filter"
          accessibilityRole="button"
          style={{ flex: 1 }}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel="Sort and filter"
        style={[
          {
            position: "absolute",
            top,
            left,
            width,
            maxHeight,
            borderRadius: 14,
            backgroundColor: colors.surface,
            boxShadow: palette.menuShadow,
            transformOrigin: [originX, 0, 0],
          },
          menuStyle,
        ]}
      >
        <ScrollView
          bounces={false}
          contentContainerStyle={{ paddingVertical: 6 }}
          style={{
            flexShrink: 1,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
          }}
        >
          <MenuHeading text="Sort by" />
          <SortGroup
            selectedIndex={selectedIndex}
            reducedMotion={reducedMotion}
          >
            {SORT_FAMILIES.map((family) => (
              <SortRow
                key={family.key}
                label={family.label}
                selected={family.key === current.family}
                direction={family.key === current.family ? current.label : null}
                reversed={family.key === current.family && current.reversed}
                flips={family.directions.length > 1}
                onPress={() => onSortChange(nextSort(family.key, sortBy))}
              />
            ))}
          </SortGroup>
          <View
            style={{
              height: 1,
              marginVertical: 6,
              backgroundColor: colors.border,
            }}
          />
          <MenuHeading text="Filter" />
          <Disclosure
            label="Location"
            summary={summarizeChoices(filters.locations, options.locations)}
            active={filters.locations.length > 0}
          >
            {options.locations.map((option) => (
              <CheckRow
                key={option.value}
                option={option}
                checked={filters.locations.includes(option.value)}
                onPress={() =>
                  onFiltersChange((f) => ({
                    ...f,
                    locations: toggleIn(f.locations, option.value),
                  }))
                }
              />
            ))}
          </Disclosure>
          <Disclosure
            label="Category"
            summary={summarizeChoices(filters.categories, options.categories)}
            active={filters.categories.length > 0}
          >
            {options.categories.map((option) => (
              <CheckRow
                key={option.value}
                option={option}
                checked={filters.categories.includes(option.value)}
                onPress={() =>
                  onFiltersChange((f) => ({
                    ...f,
                    categories: toggleIn(f.categories, option.value),
                  }))
                }
              />
            ))}
          </Disclosure>
          <SwitchRow
            label="Expiring this week"
            on={filters.expiringWeek}
            onPress={() =>
              onFiltersChange((f) => ({ ...f, expiringWeek: !f.expiringWeek }))
            }
          />
          <SwitchRow
            label="Leftovers only"
            on={filters.leftoversOnly}
            onPress={() =>
              onFiltersChange((f) => ({
                ...f,
                leftoversOnly: !f.leftoversOnly,
              }))
            }
          />
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            paddingVertical: 8,
            paddingLeft: 16,
            paddingRight: 10,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          <Pressable
            onPress={() => onFiltersChange(() => EMPTY_FILTERS)}
            disabled={active === 0}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityState={{ disabled: active === 0 }}
            style={({ pressed }) => ({
              opacity: active === 0 ? 0.4 : pressed ? 0.6 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 13,
                color: colors.accent,
              }}
            >
              Clear filters
            </Text>
          </Pressable>
          <PressableScale
            onPress={onClose}
            accessibilityRole="button"
            style={{
              height: 34,
              paddingHorizontal: 16,
              borderRadius: 10,
              justifyContent: "center",
              backgroundColor: colors.accent,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 13,
                color: colors.accentInk,
              }}
            >
              Done
            </Text>
          </PressableScale>
        </View>
      </Animated.View>
    </Modal>
  );
}

function SortGroup({
  selectedIndex,
  reducedMotion,
  children,
}: {
  selectedIndex: number;
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const offset = useSharedValue(selectedIndex * MENU_ROW_HEIGHT);
  useEffect(() => {
    const target = selectedIndex * MENU_ROW_HEIGHT;
    offset.value = reducedMotion ? target : withSpring(target, TAB_SPRING);
  }, [offset, selectedIndex, reducedMotion]);
  const highlightStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));
  return (
    <View>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: 0,
            left: 6,
            right: 6,
            height: MENU_ROW_HEIGHT,
            borderRadius: 10,
            backgroundColor: colors.accentSoft,
          },
          highlightStyle,
        ]}
      />
      {children}
    </View>
  );
}

function summarizeChoices(chosen: string[], options: FilterOption[]): string {
  if (chosen.length === 0) return "All";
  if (chosen.length > 1) return `${chosen.length} selected`;
  return (
    options.find((option) => option.value === chosen[0])?.label ?? "1 selected"
  );
}
