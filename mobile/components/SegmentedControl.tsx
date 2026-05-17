import { Text, View, Pressable } from "react-native";
import { useTheme } from "@/hooks/useTheme";

type SegmentedControlProps = {
  options: string[];
  selected: string;
  onSelect: (option: string) => void;
};

function SegmentedControl({
  options,
  selected,
  onSelect,
}: SegmentedControlProps) {
  const { colors } = useTheme();

  return (
    <View
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
