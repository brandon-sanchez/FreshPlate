import { StyleSheet, Text } from "react-native";
import { RecipePressable } from "@/components/recipe-motion";
import { useTheme } from "@/hooks/useTheme";

type BlockButtonProps = {
  label: string;
  onPress: () => void;
  /** `primary` is filled with the accent color; `secondary` is a quiet fill. */
  variant: "primary" | "secondary";
  testID?: string;
};

/**
 * Renders a full-width 48 pt button with a press shrink. Mirrors the
 * mockup's block `Button` at size `md` in `ui.jsx`.
 */
export default function BlockButton({
  label,
  onPress,
  variant,
  testID,
}: BlockButtonProps) {
  const { colors, fonts } = useTheme();
  const primary = variant === "primary";
  return (
    <RecipePressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      style={[
        styles.button,
        { backgroundColor: primary ? colors.accent : colors.surfaceAlt },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color: primary ? colors.accentInk : colors.text,
            fontFamily: fonts.bodyStrong,
          },
        ]}
      >
        {label}
      </Text>
    </RecipePressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: "stretch",
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  label: { fontSize: 15 },
});
