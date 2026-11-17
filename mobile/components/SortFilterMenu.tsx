import { useEffect, useState } from "react";
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
  MenuHeading,
  menuPalette,
  SortList,
  SwitchRow,
} from "@/components/SortFilterMenuRows";
import PressableScale from "@/components/PressableScale";
import { useTheme } from "@/hooks/useTheme";
import { anchoredFrame, type WindowRect } from "@/lib/anchoredFrame";
import type { SortBy } from "@/lib/foodSort";
import {
  countActiveFilters,
  EMPTY_FILTERS,
  FILTER_LISTS,
  FILTER_SWITCHES,
  type FilterChoices,
  type InventoryFilters,
  summarizeChoices,
  toggleChoice,
  toggleSwitch,
} from "@/lib/inventoryFilters";
import { MENU_CLOSE_MS, MENU_SPRING } from "@/lib/motion";

const MENU_WIDTH = 284;
const OPEN_FADE_MS = 120;
const OPEN_SCALE = 0.9;
const CLOSED_SCALE = 0.96;

type SortFilterMenuProps = {
  /** Whether the menu is showing. It animates out before it unmounts. */
  open: boolean;
  /** The trigger the menu hangs from; `null` until the trigger is measured. */
  anchor: WindowRect | null;
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
  options: FilterChoices;
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
  const { colors, colorScheme } = useTheme();
  const palette = menuPalette(colorScheme);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { mounted, menuStyle, scrimStyle } = useMenuPresence(open);

  if (!mounted || !anchor) return null;
  const frame = anchoredFrame(anchor, window, insets.bottom, MENU_WIDTH);

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
        {/* Closing on touch-down lets a drag that starts outside the menu
            dismiss it; onPress covers screen readers, which send only a press. */}
        <Pressable
          onPressIn={onClose}
          onPress={onClose}
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
            top: frame.top,
            left: frame.left,
            width: frame.width,
            maxHeight: frame.maxHeight,
            borderRadius: 14,
            backgroundColor: colors.surface,
            boxShadow: palette.menuShadow,
            transformOrigin: [frame.originX, 0, 0],
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
          <SortList sortBy={sortBy} onSortChange={onSortChange} />
          <View
            style={{
              height: 1,
              marginVertical: 6,
              backgroundColor: colors.border,
            }}
          />
          <MenuHeading text="Filter" />
          {FILTER_LISTS.map(({ key, label }) => {
            const chosen: string[] = filters[key];
            return (
              <Disclosure
                key={key}
                label={label}
                summary={summarizeChoices(chosen, options[key])}
                active={chosen.length > 0}
              >
                {options[key].map((option) => (
                  <CheckRow
                    key={option.value}
                    option={option}
                    checked={chosen.includes(option.value)}
                    onPress={() =>
                      onFiltersChange((f) =>
                        toggleChoice(
                          f,
                          key,
                          option.value as InventoryFilters[typeof key][number],
                        ),
                      )
                    }
                  />
                ))}
              </Disclosure>
            );
          })}
          {FILTER_SWITCHES.map(({ key, label }) => (
            <SwitchRow
              key={key}
              label={label}
              on={filters[key]}
              onPress={() => onFiltersChange((f) => toggleSwitch(f, key))}
            />
          ))}
        </ScrollView>
        <MenuFooter
          canClear={countActiveFilters(filters) > 0}
          onClear={() => onFiltersChange(() => EMPTY_FILTERS)}
          onDone={onClose}
        />
      </Animated.View>
    </Modal>
  );
}

/**
 * Keeps the menu mounted while it animates out, and returns the styles that
 * scale and fade it in and out.
 */
function useMenuPresence(open: boolean) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (open) {
      setMounted(true);
      opacity.value = withTiming(1, { duration: OPEN_FADE_MS });
      scale.value = reducedMotion ? 1 : OPEN_SCALE;
      if (!reducedMotion) scale.value = withSpring(1, MENU_SPRING);
      return;
    }
    const closing = { duration: MENU_CLOSE_MS, easing: Easing.in(Easing.quad) };
    if (!reducedMotion) scale.value = withTiming(CLOSED_SCALE, closing);
    // Reopening during the fade restarts the timing, which reports
    // `finished: false`, so the menu stays mounted.
    opacity.value = withTiming(0, closing, (finished) => {
      if (finished) runOnJS(setMounted)(false);
    });
  }, [open, opacity, scale, reducedMotion]);

  const menuStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return { mounted, menuStyle, scrimStyle };
}

function MenuFooter({
  canClear,
  onClear,
  onDone,
}: {
  canClear: boolean;
  onClear: () => void;
  onDone: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
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
        onPress={onClear}
        disabled={!canClear}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canClear }}
        style={({ pressed }) => ({
          opacity: !canClear ? 0.4 : pressed ? 0.6 : 1,
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
        onPress={onDone}
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
  );
}
