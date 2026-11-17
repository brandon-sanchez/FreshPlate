import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
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
  /** Spoken label when `label` alone is ambiguous, such as "Package size in l" for "l". Defaults to `label`. */
  accessibilityLabel?: string;
  /**
   * Content before the label, such as a food photo, clipped to a circle of
   * {@link CHIP_LEADING_SIZE} points. Screen readers hear only the label.
   */
  leading?: ReactNode;
};

/** Diameter, in points, of the circle that holds a chip's `leading` content. */
export const CHIP_LEADING_SIZE = 22;

/** A pill button for a row of choices, such as categories, units, or suggestions. */
export default function Chip({
  label,
  state = "off",
  onPress,
  accessibilityLabel,
  leading,
}: ChipProps) {
  const { colors, fonts } = useTheme();
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
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12.5,
        paddingVertical: 6.5,
        // Pulls a leading photo toward the rounded edge and keeps the height
        // of a text-only chip, so a row of mixed chips lines up.
        ...(leading ? { paddingLeft: 3, paddingVertical: 3 } : null),
        borderRadius: 100,
        borderWidth: 1.5,
        borderColor: look.border,
        backgroundColor: look.fill,
      }}
    >
      {leading ? (
        <View
          style={{
            width: CHIP_LEADING_SIZE,
            height: CHIP_LEADING_SIZE,
            borderRadius: CHIP_LEADING_SIZE / 2,
            overflow: "hidden",
          }}
        >
          {leading}
        </View>
      ) : null}
      <Text
        style={{
          color: look.ink,
          fontFamily: fonts.bodyStrong,
          fontSize: 12.5,
          letterSpacing: -0.1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
