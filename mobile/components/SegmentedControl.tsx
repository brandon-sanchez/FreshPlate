import { Text, View, Pressable } from "react-native";
import { useTheme } from "@/hooks/useTheme";

type SegmentedControlProps<T extends string> = {
  /** The segments, left to right; each is also its label. */
  options: readonly T[];
  /** The segment drawn as selected. */
  selected: T;
  /** Called with the tapped segment. */
  onSelect: (option: T) => void;
  /**
   * How screen readers announce the segments: `radio` (the default) for a
   * form choice, `tab` when the segments switch between views of one list.
   */
  role?: "radio" | "tab";
};

/** A row of mutually exclusive segments with the selected one filled in the accent color. */
function SegmentedControl<T extends string>({
  options,
  selected,
  onSelect,
  role = "radio",
}: SegmentedControlProps<T>) {
  const { colors } = useTheme();

  return (
    <View
      accessibilityRole={role === "tab" ? "tablist" : "radiogroup"}
      style={{
        flexDirection: "row",
        backgroundColor: colors.surfaceAlt,
        padding: 4,
        borderRadius: 12,
        gap: 6,
      }}
    >
      {options.map((option) => {
        const isSelected = option === selected;
        return (
          <Pressable
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
              backgroundColor: isSelected ? colors.accent : "transparent",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: isSelected ? 0.06 : 0,
              shadowRadius: 3,
              elevation: isSelected ? 1 : 0,
            }}
          >
            <Text
              style={{
                color: isSelected ? colors.accentInk : colors.textMuted,
                fontWeight: "600",
                fontSize: 13,
                letterSpacing: -0.1,
              }}
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default SegmentedControl;
