import { StyleSheet, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";

export default function RecipeSuggestionSummary({
  recipes,
}: {
  recipes: RecipeSuggestion[];
}) {
  const { colors, fonts } = useTheme();

  return (
    <View
      style={[
        styles.summaryCard,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <View style={styles.summaryHeader}>
        <View style={styles.summaryTitleRow}>
          <FontAwesome name="magic" size={15} color={colors.accent} />
          <Text
            style={[
              styles.summaryTitle,
              { color: colors.text, fontFamily: fonts.display },
            ]}
          >
            Fresh ideas are ready
          </Text>
        </View>
        <Text
          style={[
            styles.summaryCount,
            { color: colors.accent, fontFamily: fonts.bodyStrong },
          ]}
        >
          {recipes.length}
        </Text>
      </View>
      {recipes.length > 0 ? (
        recipes.slice(0, 3).map((recipe) => (
          <View
            key={recipe.recipe_id}
            style={[styles.recipePreview, { borderTopColor: colors.border }]}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: colors.text,
                  fontFamily: fonts.bodyStrong,
                  fontSize: 15,
                }}
              >
                {recipe.title}
              </Text>
              <Text
                style={{
                  color: colors.textMuted,
                  fontFamily: fonts.body,
                  fontSize: 12,
                  marginTop: 3,
                }}
              >
                {recipe.cook_time_minutes} min · {recipe.match_percent}% match
              </Text>
            </View>
            <FontAwesome
              name="chevron-right"
              size={12}
              color={colors.textSubtle}
            />
          </View>
        ))
      ) : (
        <Text
          style={[
            styles.noSuggestions,
            { color: colors.textMuted, fontFamily: fonts.body },
          ]}
        >
          Nothing matched this context yet. Try different answers or add another
          item.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summaryCard: {
    marginHorizontal: 16,
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 18,
    overflow: "hidden",
  },
  summaryHeader: {
    minHeight: 58,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  summaryTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  summaryTitle: {
    fontSize: 18,
    letterSpacing: -0.3,
  },
  summaryCount: {
    fontSize: 14,
  },
  recipePreview: {
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderTopWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  noSuggestions: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    fontSize: 13,
    lineHeight: 19,
  },
});
