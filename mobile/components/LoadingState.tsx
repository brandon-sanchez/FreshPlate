import { ActivityIndicator, Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";

type LoadingStateProps = {
  label?: string;
};

function LoadingState({ label }: LoadingStateProps) {
  const { colors, fonts } = useTheme();

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 48,
        paddingHorizontal: 24,
        gap: 12,
      }}
    >
      <ActivityIndicator color={colors.accent} />
      {label ? (
        <Text
          style={{
            color: colors.textMuted,
            fontFamily: fonts.body,
            fontSize: 13,
          }}
        >
          {label}
        </Text>
      ) : null}
    </View>
  );
}

export default LoadingState;
