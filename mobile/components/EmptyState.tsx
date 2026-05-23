import { Pressable, Text, View } from "react-native";
import { ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";

type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  message?: string;
  ctaLabel?: string;
  onCtaPress?: () => void;
};

function EmptyState({ icon, title, message, ctaLabel, onCtaPress }: EmptyStateProps) {
  const { colors, fonts } = useTheme();

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 48,
        paddingHorizontal: 32,
        gap: 10,
      }}
    >
      {icon ? <View style={{ marginBottom: 4 }}>{icon}</View> : null}
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
      {message ? (
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
      ) : null}
      {ctaLabel && onCtaPress ? (
        <Pressable
          onPress={onCtaPress}
          style={{
            marginTop: 12,
            backgroundColor: colors.accent,
            paddingHorizontal: 18,
            paddingVertical: 10,
            borderRadius: 100,
          }}
        >
          <Text
            style={{
              color: colors.accentInk,
              fontFamily: fonts.bodyStrong,
              fontSize: 13,
              letterSpacing: -0.1,
            }}
          >
            {ctaLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default EmptyState;
