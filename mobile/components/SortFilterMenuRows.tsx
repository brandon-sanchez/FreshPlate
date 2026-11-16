import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Animated, {
  FadeIn,
  FadeOut,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import type { FilterOption } from "@/lib/inventoryFilters";
import { COLLAPSE, REDUCED_FADE_MS, TAB_SPRING } from "@/lib/motion";

/** The height of every menu row, in points; the sort highlight steps by it. */
export const MENU_ROW_HEIGHT = 44;

const SPRING = { ...TAB_SPRING, reduceMotion: ReduceMotion.System };
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

/**
 * One sort family. The selected row names its direction and shows an arrow
 * that turns over for the second direction.
 */
export function SortRow({
  label,
  selected,
  direction,
  reversed,
  flips,
  onPress,
}: {
  label: string;
  selected: boolean;
  /** The selected direction's label, or `null` when another family is selected. */
  direction: string | null;
  reversed: boolean;
  /** Whether a second tap reverses this family. */
  flips: boolean;
  onPress: () => void;
}) {
  const { colors, fonts } = useTheme();
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
