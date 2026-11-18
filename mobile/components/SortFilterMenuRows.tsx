import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Animated, {
  FadeIn,
  FadeOut,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import {
  nextSort,
  SORT_FAMILIES,
  sortDirection,
  type SortBy,
} from "@/lib/foodSort";
import type { FilterOption } from "@/lib/inventoryFilters";
import { COLLAPSE, REDUCED_FADE_MS, TAB_SPRING } from "@/lib/motion";

const MENU_ROW_HEIGHT = 44;
const SPRING = TAB_SPRING;
const FADE = { duration: REDUCED_FADE_MS };
const SWITCH_TRAVEL = 15;

/** Returns the menu colors that the theme tokens don't carry, for `scheme`. */
export function menuPalette(scheme: "light" | "dark") {
  return scheme === "dark"
    ? {
        scrim: "rgba(0, 0, 0, 0.3)",
        pressed: "rgba(255, 255, 255, 0.07)",
        menuShadow:
          "0 0 0 1px rgba(255, 255, 255, 0.07), 0 2px 6px rgba(0, 0, 0, 0.3), 0 18px 44px rgba(0, 0, 0, 0.55)",
      }
    : {
        scrim: "rgba(27, 31, 28, 0.05)",
        pressed: "rgba(27, 31, 28, 0.06)",
        menuShadow:
          "0 0 0 1px rgba(0, 0, 0, 0.05), 0 2px 6px rgba(0, 0, 0, 0.06), 0 18px 44px rgba(0, 0, 0, 0.16)",
      };
}

/** A small uppercase label over a group of rows, hidden from screen readers. */
export function MenuHeading({ text }: { text: string }) {
  const { colors, fonts } = useTheme();
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        paddingTop: 8,
        paddingBottom: 4,
        paddingHorizontal: 16,
        fontFamily: fonts.bodyStrong,
        fontSize: 11,
        letterSpacing: 0.9,
        textTransform: "uppercase",
        color: colors.textMuted,
      }}
    >
      {text}
    </Text>
  );
}

function MenuRow({
  indent = false,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Pressable>, "children" | "style"> & {
  indent?: boolean;
  children: ReactNode;
}) {
  const { colorScheme } = useTheme();
  const { pressed: pressedColor } = menuPalette(colorScheme);
  return (
    <Pressable
      {...props}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: MENU_ROW_HEIGHT,
        paddingLeft: indent ? 30 : 16,
        paddingRight: 16,
        backgroundColor: pressed ? pressedColor : "transparent",
      })}
    >
      {children}
    </Pressable>
  );
}

type RowFrame = { y: number; height: number };

/**
 * The sort families over a highlight that slides to the selected one with
 * the tab spring. Tapping a family picks its first direction; tapping the
 * selected family flips it. The highlight follows each row's measured frame,
 * so rows that grow with larger text stay covered.
 */
export function SortList({
  sortBy,
  onSortChange,
}: {
  /** The selected sort. */
  sortBy: SortBy;
  /** Called with the sort a tap picks. */
  onSortChange: (sortBy: SortBy) => void;
}) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const current = sortDirection(sortBy);
  const selected = SORT_FAMILIES.findIndex(
    (family) => family.key === current.family,
  );
  const [frames, setFrames] = useState<(RowFrame | undefined)[]>([]);
  const target = frames[selected] ?? {
    y: selected * MENU_ROW_HEIGHT,
    height: MENU_ROW_HEIGHT,
  };
  const offset = useSharedValue(target.y);
  const height = useSharedValue(target.height);
  useEffect(() => {
    offset.value = reducedMotion
      ? target.y
      : withSpring(target.y, TAB_SPRING);
    height.value = target.height;
  }, [offset, height, target.y, target.height, reducedMotion]);
  const highlightStyle = useAnimatedStyle(() => ({
    height: height.value,
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
            borderRadius: 10,
            backgroundColor: colors.accentSoft,
          },
          highlightStyle,
        ]}
      />
      {SORT_FAMILIES.map((family, index) => {
        const isSelected = index === selected;
        return (
          <SortRow
            key={family.key}
            label={family.label}
            current={isSelected ? current : null}
            flips={family.directions.length > 1}
            onPress={() => onSortChange(nextSort(family.key, sortBy))}
            onLayout={({ nativeEvent: { layout } }) =>
              setFrames((all) => {
                const next = [...all];
                next[index] = { y: layout.y, height: layout.height };
                return next;
              })
            }
          />
        );
      })}
    </View>
  );
}

/**
 * One sort family. The selected row names its direction and shows an arrow
 * that turns over for the second direction.
 */
function SortRow({
  label,
  current,
  flips,
  onPress,
  onLayout,
}: {
  label: string;
  /** The selected direction, or `null` when another family is selected. */
  current: { label: string; reversed: boolean } | null;
  /** Whether a second tap reverses this family. */
  flips: boolean;
  onPress: () => void;
  onLayout: React.ComponentProps<typeof Pressable>["onLayout"];
}) {
  const { colors, fonts } = useTheme();
  const selected = current !== null;
  const reversed = current?.reversed ?? false;
  const direction = current?.label ?? null;
  const turn = useSharedValue(reversed ? 180 : 0);
  const shown = useSharedValue(selected && flips ? 1 : 0);
  useEffect(() => {
    turn.value = withSpring(reversed ? 180 : 0, SPRING);
    shown.value = withTiming(selected && flips ? 1 : 0, FADE);
  }, [turn, shown, reversed, selected, flips]);
  const arrowStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ rotate: `${turn.value}deg` }],
  }));

  return (
    <MenuRow
      onPress={onPress}
      onLayout={onLayout}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      accessibilityValue={direction ? { text: direction } : undefined}
      accessibilityHint={selected && flips ? "Reverses the order" : undefined}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: selected ? fonts.bodyStrong : fonts.body,
          fontSize: 14.5,
          letterSpacing: -0.15,
          color: selected ? colors.accent : colors.text,
        }}
      >
        {label}
      </Text>
      {direction ? (
        <Animated.Text
          key={direction}
          entering={FadeIn.duration(200)}
          style={{
            fontFamily: fonts.body,
            fontSize: 12.5,
            color: colors.accent,
          }}
        >
          {direction}
        </Animated.Text>
      ) : null}
      <Animated.View style={arrowStyle}>
        <Feather name="arrow-up" size={15} color={colors.accent} />
      </Animated.View>
    </MenuRow>
  );
}

/**
 * A filter row that expands in place to show its options. Its value names
 * what is chosen, in the accent color when anything is.
 */
export function Disclosure({
  label,
  summary,
  active,
  children,
}: {
  label: string;
  summary: string;
  active: boolean;
  children: ReactNode;
}) {
  const { colors, fonts } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const progress = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, {
      ...COLLAPSE,
      reduceMotion: ReduceMotion.System,
    });
  }, [progress, expanded]);
  const bodyStyle = useAnimatedStyle(() => ({
    height: progress.value * contentHeight.value,
  }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 90}deg` }],
  }));

  return (
    <View>
      <MenuRow
        onPress={() => setExpanded((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: summary }}
        accessibilityState={{ expanded }}
      >
        <Text
          style={{
            flex: 1,
            fontFamily: fonts.body,
            fontSize: 14.5,
            color: colors.text,
          }}
        >
          {label}
        </Text>
        <Animated.Text
          key={summary}
          entering={FadeIn.duration(200)}
          numberOfLines={1}
          style={{
            maxWidth: 120,
            fontFamily: active ? fonts.bodyStrong : fonts.body,
            fontSize: 13,
            color: active ? colors.accent : colors.textMuted,
          }}
        >
          {summary}
        </Animated.Text>
        <Animated.View style={chevronStyle}>
          <Feather name="chevron-right" size={14} color={colors.textMuted} />
        </Animated.View>
      </MenuRow>
      <Animated.View
        style={[
          { overflow: "hidden", backgroundColor: colors.surfaceAlt + "8C" },
          bodyStyle,
        ]}
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
        pointerEvents={expanded ? "auto" : "none"}
      >
        <View
          style={{ position: "absolute", top: 0, left: 0, right: 0 }}
          onLayout={(event) => {
            contentHeight.value = event.nativeEvent.layout.height;
          }}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}

/** A place or category to filter by, with its food count and a check when chosen. */
export function CheckRow({
  option,
  checked,
  onPress,
}: {
  option: FilterOption;
  checked: boolean;
  onPress: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <MenuRow
      indent
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityLabel={option.label}
      accessibilityValue={{
        text: `${option.count} item${option.count === 1 ? "" : "s"}`,
      }}
      accessibilityState={{ checked }}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: fonts.body,
          fontSize: 14,
          color: colors.text,
        }}
      >
        {option.label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 11.5,
          color: colors.textMuted,
          fontVariant: ["tabular-nums"],
        }}
      >
        {option.count}
      </Text>
      <View style={{ width: 18, alignItems: "center" }}>
        {checked ? (
          <Animated.View
            entering={FadeIn.duration(REDUCED_FADE_MS)}
            exiting={FadeOut.duration(120)}
          >
            <Feather name="check" size={16} color={colors.accent} />
          </Animated.View>
        ) : null}
      </View>
    </MenuRow>
  );
}

/** A yes-or-no filter drawn as a switch whose thumb springs across. */
export function SwitchRow({
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  const { colors, fonts } = useTheme();
  const progress = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(on ? 1 : 0, SPRING);
  }, [progress, on]);
  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.border, colors.accent],
    ),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * SWITCH_TRAVEL }],
  }));

  return (
    <MenuRow
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: fonts.body,
          fontSize: 14.5,
          color: colors.text,
        }}
      >
        {label}
      </Text>
      <Animated.View
        style={[
          { width: 38, height: 23, borderRadius: 12, padding: 2 },
          trackStyle,
        ]}
      >
        <Animated.View
          style={[
            {
              width: 19,
              height: 19,
              borderRadius: 10,
              backgroundColor: "#FFFFFF",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.25)",
            },
            thumbStyle,
          ]}
        />
      </Animated.View>
    </MenuRow>
  );
}
