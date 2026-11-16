import type { ComponentProps } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Feather from "@expo/vector-icons/Feather";
import BlockButton from "@/components/block-button";
import { motionDuration } from "@/constants/motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";


type RecipeFeedMessageProps = {
  /** Feather icon shown in the tinted circle above the text. */
  icon: "check-circle" | "cloud-off" | "shopping-bag";
  /** Optional headline above the message. */
  title?: string;
  /** The sentence that explains the state. */
  message: string;
  /** Announces the text as an alert, for errors. */
  isError?: boolean;
  /** Buttons under the text, such as "Try again", in order. */
  actions: ComponentProps<typeof BlockButton>[];
  /** Test id for the message container. */
  testID?: string;
};

/**
 * Shows a feed status (an error, the end of the set, or an inventory too
 * thin for recipes) as centered text on the feed's own background, with no
 * card behind it, so it never reads as another recipe. It fades in on mount;
 * with Reduce Motion on, it appears at once.
 */
export default function RecipeFeedMessage({
  icon,
  title,
  message,
  isError = false,
  actions,
  testID,
}: RecipeFeedMessageProps) {
  const { colors, fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  return (
    <Animated.View
      testID={testID}
      entering={
        reducedMotion ? undefined : FadeIn.duration(motionDuration.normal)
      }
      style={styles.container}
    >
      <View
        accessible
        accessibilityRole={isError ? "alert" : "text"}
        accessibilityLabel={title ? `${title}. ${message}` : message}
        accessibilityLiveRegion="polite"
        style={styles.text}
      >
        <View
          style={[styles.iconCircle, { backgroundColor: colors.accentSoft }]}
        >
          <Feather name={icon} size={24} color={colors.accent} />
        </View>
        {title ? (
          <Text
            style={[
              styles.title,
              { color: colors.text, fontFamily: fonts.display },
            ]}
          >
            {title}
          </Text>
        ) : null}
        <Text
          style={[
            styles.message,
            { color: colors.textMuted, fontFamily: fonts.body },
          ]}
        >
          {message}
        </Text>
      </View>
      <View style={styles.actions}>
        {actions.map((action) => (
          <BlockButton key={action.label} {...action} />
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 24,
    paddingVertical: 32,
    alignItems: "center",
    gap: 20,
  },
  text: { alignItems: "center", gap: 10, maxWidth: 280 },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.3,
    textAlign: "center",
  },
  message: { fontSize: 14, lineHeight: 21, textAlign: "center" },
  actions: { alignSelf: "stretch", gap: 12 },
});
