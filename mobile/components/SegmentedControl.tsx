import { useEffect, useRef } from "react";
import { View } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { RecipePressable } from "@/components/recipe-motion";
import { useTheme } from "@/hooks/useTheme";
import { TAB_SPRING } from "@/lib/motion";

const PADDING = 4;
const GAP = 6;

type SegmentedControlProps<T extends string> = {
  /** The segments, left to right; each is also its label. */
  options: readonly T[];
  /**
   * The segment drawn as selected. A value that matches no segment, such as
   * a batch amount between two fill levels, leaves every segment unselected.
   */
  selected: T;
  /** Called with the tapped segment. */
  onSelect: (option: T) => void;
  /**
   * How screen readers announce the segments: `radio` (the default) for a
   * form choice, `tab` when the segments switch between views of one list.
   */
  role?: "radio" | "tab";
};

/**
 * A row of mutually exclusive segments. An accent indicator slides to the
 * selected segment with the tab bar's spring, and each label takes the
 * accent ink as the indicator passes under it. With Reduce Motion on, the
 * indicator moves at once, because Reanimated springs follow the system
 * setting by default.
 */
function SegmentedControl<T extends string>({
  options,
  selected,
  onSelect,
  role = "radio",
}: SegmentedControlProps<T>) {
  const { colors } = useTheme();
  const count = options.length;
  const selectedIndex = options.indexOf(selected);
  const hasSelection = selectedIndex >= 0;
  const position = useSharedValue(Math.max(0, selectedIndex));
  const shown = useSharedValue(hasSelection ? 1 : 0);
  const width = useSharedValue(0);
  const wasShown = useRef(hasSelection);

  useEffect(() => {
    // An indicator that was hidden appears in place rather than sliding in
    // from the segment it last sat under.
    if (hasSelection && wasShown.current) {
      position.value = withSpring(selectedIndex, TAB_SPRING);
    } else if (hasSelection) {
      position.value = selectedIndex;
    }
    shown.value = hasSelection ? 1 : 0;
    wasShown.current = hasSelection;
  }, [position, shown, selectedIndex, hasSelection]);

  const indicatorStyle = useAnimatedStyle(() => {
    const segment = (width.value - PADDING * 2 - GAP * (count - 1)) / count;
    return {
      opacity: segment > 0 ? shown.value : 0,
      width: Math.max(0, segment),
      transform: [{ translateX: position.value * (segment + GAP) }],
    };
  });

  return (
    <View
      accessibilityRole={role === "tab" ? "tablist" : "radiogroup"}
      onLayout={(event) => {
        width.value = event.nativeEvent.layout.width;
      }}
      style={{
        flexDirection: "row",
        backgroundColor: colors.surfaceAlt,
        padding: PADDING,
        borderRadius: 12,
        gap: GAP,
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: PADDING,
            bottom: PADDING,
            left: PADDING,
            borderRadius: 9,
            backgroundColor: colors.accent,
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
          },
          indicatorStyle,
        ]}
      />
      {options.map((option, index) => {
        const isSelected = option === selected;
        return (
          <RecipePressable
            key={option}
            onPress={() => onSelect(option)}
            accessibilityRole={role}
            accessibilityLabel={option}
            accessibilityState={role === "tab" ? { selected: isSelected } : { checked: isSelected }}
            style={{
              flex: 1,
              paddingVertical: 10,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <SegmentLabel
              label={option}
              index={index}
              position={position}
              shown={shown}
              width={width}
              on={colors.accentInk}
              off={colors.textMuted}
            />
          </RecipePressable>
        );
      })}
    </View>
  );
}

function SegmentLabel({
  label,
  index,
  position,
  shown,
  width,
  on,
  off,
}: {
  label: string;
  index: number;
  position: SharedValue<number>;
  shown: SharedValue<number>;
  width: SharedValue<number>;
  on: string;
  off: string;
}) {
  const colorStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      // Until the indicator is laid out and shown, every label stays muted,
      // so the selected label never draws in accent ink on the bare track.
      shown.value === 0 || width.value === 0
        ? 1
        : Math.min(1, Math.abs(position.value - index)),
      [0, 1],
      [on, off],
    ),
  }));
  return (
    <Animated.Text
      style={[{ fontWeight: "600", fontSize: 13, letterSpacing: -0.1 }, colorStyle]}
    >
      {label}
    </Animated.Text>
  );
}

export default SegmentedControl;
