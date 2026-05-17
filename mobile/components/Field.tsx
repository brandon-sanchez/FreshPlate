import { View, Text } from "react-native";
import { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";

type FieldProps = {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
};

function Field({ label, hint, error, children }: FieldProps) {
  const { colors, fonts } = useTheme();
  const message = error ?? hint;
  const messageColor = error ? colors.crit : colors.textSubtle;

  return (
    <View>
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 12,
          fontWeight: "600",
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.7,
          marginBottom: 8,
        }}
      >
        {label}
      </Text>
      {children}
      {message ? (
        <Text style={{ fontSize: 11.5, color: messageColor, marginTop: 6 }}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

export default Field;
