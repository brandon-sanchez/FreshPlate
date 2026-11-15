import { useRef } from "react";
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Toast from "react-native-toast-message";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";
import RecipePhoto from "@/components/recipe-photo";
import RecipeSaveButton from "@/components/recipe-save-button";
import RecipeStats from "@/components/recipe-stats";
import RecipeSteps from "@/components/recipe-steps";

// Height of the hero photo below the status bar, in points.
const HERO_HEIGHT = 240;

type RecipeDetailProps = {
  recipe: RecipeSuggestion | null;
  isSaved: boolean;
  isSavePending: boolean;
  onToggleSave: (recipe: RecipeSuggestion, saved: boolean) => void;
  onClose: () => void;
};

export default function RecipeDetail({
  recipe,
  isSaved,
  isSavePending,
  onToggleSave,
  onClose,
}: RecipeDetailProps) {
  const reducedMotion = useReducedMotion();

  return (
    <Modal
      visible={recipe !== null}
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={onClose}
    >
      {recipe && (
        // Keyed so each recipe starts with a fresh scroll position.
        <RecipeDetailScreen
          key={recipe.recipe_id}
          recipe={recipe}
          isSaved={isSaved}
          isSavePending={isSavePending}
          onToggleSave={onToggleSave}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function RecipeDetailScreen({
  recipe,
  isSaved,
  isSavePending,
  onToggleSave,
  onClose,
}: RecipeDetailProps & { recipe: RecipeSuggestion }) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const twoColumns = width >= 360 && fontScale < 1.6;
  const heroHeight = insets.top + HERO_HEIGHT;
  const scrollY = useRef(new Animated.Value(0)).current;
  const statusBackdropOpacity = scrollY.interpolate({
    inputRange: [HERO_HEIGHT - 24, HERO_HEIGHT],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Animated.ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
      >
        <RecipePhoto
          recipeId={recipe.recipe_id}
          title={recipe.title}
          variant="hero"
          style={{ height: heroHeight }}
        />
        <View style={styles.content}>
          <Text
            selectable
            style={[
              styles.title,
              { color: colors.text, fontFamily: fonts.display },
            ]}
          >
            {recipe.title}
          </Text>
          <RecipeStats recipe={recipe} style={styles.stats} />
          <Text
            style={[
              styles.heading,
              { color: colors.textMuted, fontFamily: fonts.bodyStrong },
            ]}
          >
            Ingredients
          </Text>
          <View
            style={[
              styles.ingredientBox,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          >
            {(twoColumns
              ? [
                  recipe.ingredients.slice(
                    0,
                    Math.ceil(recipe.ingredients.length / 2),
                  ),
                  recipe.ingredients.slice(
                    Math.ceil(recipe.ingredients.length / 2),
                  ),
                ]
              : [recipe.ingredients]
            ).map((column, columnIndex) => (
              <View
                key={`ingredient-column-${columnIndex}`}
                testID={`recipe-detail-ingredient-column-${columnIndex}`}
                style={styles.ingredientColumn}
              >
                {column.map((item, index) => {
                  const itemIndex = twoColumns
                    ? columnIndex * Math.ceil(recipe.ingredients.length / 2) +
                      index
                    : index;
                  return (
                    <View
                      key={`${item.name}-${itemIndex}`}
                      testID={`recipe-detail-ingredient-${itemIndex}`}
                      style={styles.ingredient}
                    >
                      <Text
                        style={{
                          color: colors.accent,
                          fontSize: 18,
                          lineHeight: 20,
                        }}
                      >
                        •
                      </Text>
                      <Text
                        selectable
                        style={{
                          color: colors.text,
                          fontFamily: fonts.body,
                          fontSize: 14,
                          lineHeight: 20,
                          flex: 1,
                        }}
                      >
                        <Text style={{ fontFamily: fonts.bodyStrong }}>
                          {Number(item.use_amount.toFixed(2))} {item.unit}
                        </Text>{" "}
                        {item.name}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
          <Text
            style={[
              styles.heading,
              { color: colors.textMuted, fontFamily: fonts.bodyStrong },
            ]}
          >
            Steps
          </Text>
          <RecipeSteps steps={recipe.steps} />
        </View>
      </Animated.ScrollView>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.statusBackdrop,
          {
            height: insets.top,
            backgroundColor: colors.bg,
            opacity: statusBackdropOpacity,
          },
        ]}
      />
      <RecipePressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close recipe details"
        style={[styles.heroButton, { top: insets.top + 8, left: 16 }]}
      >
        <Feather name="chevron-left" size={24} color="#1B1F1C" />
      </RecipePressable>
      <RecipeSaveButton
        variant="round"
        saved={isSaved}
        title={recipe.title}
        disabled={isSavePending}
        onPress={() => onToggleSave(recipe, isSaved)}
        testID="recipe-detail-save"
        style={[styles.heroControl, { top: insets.top + 8, right: 16 }]}
      />
      <Toast topOffset={insets.top + 60} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  statusBackdrop: { position: "absolute", top: 0, left: 0, right: 0 },
  heroControl: { position: "absolute" },
  heroButton: {
    position: "absolute",
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  content: { padding: 20 },
  title: { fontSize: 26, lineHeight: 32 },
  stats: { marginTop: 16 },
  heading: {
    fontSize: 13,
    textTransform: "uppercase",
    marginTop: 24,
    marginBottom: 10,
  },
  ingredientBox: {
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  ingredient: {
    padding: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  ingredientColumn: { flex: 1, minWidth: 0 },
});
