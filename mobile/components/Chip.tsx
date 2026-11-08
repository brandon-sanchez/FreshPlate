import { Pressable, Text } from "react-native";
import { useTheme } from "@/hooks/useTheme";

type ChipProps = {
  /** Text shown in the pill. */
  label: string;
  /**
   * `"on"` fills the chip with the accent color. `"guessed"` outlines it in the
   * accent color instead, for a value the app picked that the user still has
   * to confirm. Defaults to `"off"`.
   */
  state?: "off" | "on" | "guessed";
  /** Called when the chip is pressed. */
  onPress: () => void;
  /** Spoken label when `label` alone is ambiguous, such as "Package size in l" for "l". */
  accessibilityLabel?: string;
};

/** A pill button for a row of choices, such as categories, units, or suggestions. */
export default function Chip({
  label,
  state = "off",
  onPress,
  accessibilityLabel,
}: ChipProps) {
  const { colors } = useTheme();
  const look = {
    off: {
      fill: colors.surfaceAlt,
      border: colors.surfaceAlt,
      ink: colors.textMuted,
    },
    on: { fill: colors.accent, border: colors.accent, ink: colors.accentInk },
    guessed: {
      fill: colors.surface,
      border: colors.accent,
      ink: colors.accent,
    },
  }[state];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: state !== "off" }}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={{
        paddingHorizontal: 12.5,
        paddingVertical: 6.5,
        borderRadius: 100,
        borderWidth: 1.5,
        borderColor: look.border,
        backgroundColor: look.fill,
      }}
    >
      <Text
        style={{
          color: look.ink,
          fontWeight: "600",
          fontSize: 12.5,
          letterSpacing: -0.1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
