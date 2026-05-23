import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";

type ErrorStateProps = {
  title?: string;
  message?: string;
  onRetry?: () => void;
};

function ErrorState({
  title = "Something went wrong",
  message = "We couldn't load this right now. Check your connection and try again.",
  onRetry,
}: ErrorStateProps) {
  const { colors, fonts } = useTheme();

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 48,
        paddingHorizontal: 32,
        gap: 8,
      }}
    >
      <Text
        style={{
          color: colors.crit,
          fontFamily: fonts.bodyStrong,
          fontSize: 12,
          letterSpacing: 0.7,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        Error
      </Text>
      <Text
        style={{
          color: colors.text,
          fontFamily: fonts.display,
          fontSize: 18,
          textAlign: "center",
          letterSpacing: -0.3,
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          color: colors.textMuted,
          fontFamily: fonts.body,
          fontSize: 13.5,
          textAlign: "center",
          lineHeight: 19,
        }}
      >
        {message}
      </Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={{
            marginTop: 14,
            paddingHorizontal: 18,
            paddingVertical: 10,
            borderRadius: 100,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <Text
            style={{
              color: colors.text,
              fontFamily: fonts.bodyStrong,
              fontSize: 13,
              letterSpacing: -0.1,
            }}
          >
            Try again
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default ErrorState;
