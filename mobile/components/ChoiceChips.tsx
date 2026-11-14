import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";

/** One chip: `key` must be unique within the row, `label` is shown and read aloud. */
export type Choice<T> = { key: string; label: string; value: T };

type ChoiceChipsProps<T> = {
  /** The chips, in display order. */
  choices: readonly Choice<T>[];
  /** The value of the chip shown as picked, compared with `===`. */
  selected: T;
  /** Called with the tapped chip's value. */
  onSelect: (value: T) => void;
};

/** Renders a wrapping row of pill chips where one is picked at a time. */
function ChoiceChips<T>({ choices, selected, onSelect }: ChoiceChipsProps<T>) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {choices.map(({ key, label, value }) => {
        const isSelected = value === selected;
        return (
          <Pressable
            key={key}
            onPress={() => onSelect(value)}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: isSelected }}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 100,
              backgroundColor: isSelected ? colors.accent : colors.surfaceAlt,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 12.5,
                letterSpacing: -0.1,
                color: isSelected ? colors.accentInk : colors.textMuted,
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default ChoiceChips;
