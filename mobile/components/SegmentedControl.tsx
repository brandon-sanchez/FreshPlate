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
    <View style={{ flexDirection: "row", height: 44, borderRadius: 10, overflow: "hidden" }}>
      {options.map((option) => (
        <Pressable
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: option === selected ? colors.accent : colors.surfaceAlt,
          }}
          key={option}
          onPress={() => onSelect(option)}
        >
          <Text
            style={{
              color: option === selected ? colors.accentInk : colors.text,
              fontWeight: "600",
              fontSize: 14,
            }}
          >
            {option}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export default SegmentedControl;
