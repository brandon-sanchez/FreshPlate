import { RecipePressable } from "@/components/recipe-motion";
import { StyleSheet, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import { countAnsweredPreferences, recipeContextLabel } from "@/lib/recipes";
import type { RecipePreferences } from "@/types/recipes";

export function RecipeScreenHeader({ subtitle }: { subtitle: string }) {
  const { colors, fonts } = useTheme();

  return (
    <View style={styles.topBar}>
      <Text
        style={[styles.screenTitle, { color: colors.text, fontFamily: fonts.display }]}
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
  const hasAnswers = countAnsweredPreferences(preferences) > 0;

  return (
    <View
      style={[
        styles.contextBar,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.contextCopy}>
        <FontAwesome name="magic" size={15} color={colors.accent} />
        <Text
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
        style={[styles.askButton, { backgroundColor: colors.surfaceAlt }]}
      >
        <FontAwesome name="list" size={12} color={colors.textMuted} />
        <Text
          style={[
            styles.askButtonText,
            { color: colors.textMuted, fontFamily: fonts.bodyStrong },
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
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  screenTitle: {
    fontSize: 22,
    letterSpacing: -0.6,
  },
  screenSubtitle: {
    fontSize: 13,
    marginTop: 3,
  },
  contextBar: {
    marginHorizontal: 16,
    minHeight: 54,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 0,
    borderRadius: 14,
    marginBottom: 14,
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
  },
  askButton: {
    minHeight: 44,
    paddingHorizontal: 11,
    borderRadius: 100,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  askButtonText: {
    fontSize: 12,
  },
});
