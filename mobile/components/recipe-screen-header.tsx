import { RecipePressable } from "@/components/recipe-motion";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useTheme } from "@/hooks/useTheme";
import { countAnsweredPreferences, recipeContextLabel } from "@/lib/recipes";
import type { RecipePreferences } from "@/types/recipes";

export function RecipeScreenHeader({ subtitle }: { subtitle: string }) {
  const { colors, fonts } = useTheme();

  return (
    <View style={styles.topBar}>
      <Text
        style={[
          styles.screenTitle,
          { color: colors.text, fontFamily: fonts.display },
        ]}
      >
        Recipes
      </Text>
      <Text
        style={[
          styles.screenSubtitle,
          { color: colors.textMuted, fontFamily: fonts.body },
        ]}
      >
        {subtitle}
      </Text>
    </View>
  );
}

export function RecipeContextBar({
  itemCount,
  preferences,
  onAsk,
}: {
  itemCount: number;
  preferences: RecipePreferences;
  onAsk: () => void;
}) {
  const { colors, fonts } = useTheme();
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale > 1.2;
  const hasAnswers = countAnsweredPreferences(preferences) > 0;

  return (
    <View
      style={[
        styles.contextBar,
        largeText && styles.stackedContextBar,
        { borderColor: colors.border },
      ]}
    >
      <View
        style={[styles.contextCopy, largeText && styles.stackedContextCopy]}
      >
        <Feather name="feather" size={15} color={colors.accent} />
        <Text
          key={fontScale}
          style={[
            styles.contextText,
            { color: colors.textMuted, fontFamily: fonts.body },
          ]}
        >
          {recipeContextLabel(itemCount, preferences)}
        </Text>
      </View>
      <RecipePressable
        onPress={onAsk}
        accessibilityRole="button"
        style={[
          styles.askButton,
          largeText && styles.stackedAskButton,
          { backgroundColor: colors.surfaceAlt },
        ]}
      >
        <Feather name="sliders" size={14} color={colors.accent} />
        <Text
          key={fontScale}
          style={[
            styles.askButtonText,
            { color: colors.accent, fontFamily: fonts.bodyStrong },
          ]}
        >
          {hasAnswers ? "Edit answers" : "Ask me questions"}
        </Text>
      </RecipePressable>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    paddingHorizontal: 24,
    paddingTop: 8,
    marginBottom: 18,
  },
  screenTitle: {
    fontSize: 32,
    lineHeight: 39,
    letterSpacing: -0.8,
  },
  screenSubtitle: {
    fontSize: 13,
    lineHeight: 20,
    marginTop: 4,
  },
  contextBar: {
    marginHorizontal: 24,
    minHeight: 54,
    paddingBottom: 16,
    borderBottomWidth: 1,
    marginBottom: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  contextCopy: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  contextText: {
    fontSize: 12,
    lineHeight: 18,
    flexShrink: 1,
  },
  stackedContextBar: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 12,
  },
  stackedContextCopy: {
    flex: 0,
  },
  askButton: {
    minHeight: 44,
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderRadius: 100,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: "100%",
  },
  stackedAskButton: {
    alignSelf: "flex-start",
  },
  askButtonText: {
    fontSize: 12,
    lineHeight: 18,
    flexShrink: 1,
  },
});
