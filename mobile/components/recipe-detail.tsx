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
import Ionicons from "@expo/vector-icons/Ionicons";
import { ToastHost } from "@/components/toastConfig";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";
import FoodPhoto from "@/components/food-photo";
import RecipePhoto from "@/components/recipe-photo";
import RecipeSaveButton from "@/components/recipe-save-button";
import RecipeStats from "@/components/recipe-stats";
import RecipeSteps from "@/components/recipe-steps";
import { formatIngredientAmount } from "@/lib/recipe-format";
import { isKitchenBasic } from "@/lib/recipes";

// Height of the hero photo below the status bar, in points.
const HERO_HEIGHT = 240;

const FOOTER_TOP_PADDING = 16;
const COOK_BUTTON_HEIGHT = 54;
const FOOTER_BOTTOM_GAP = 14;

/**
 * Returns how far the top edge of {@link RecipeView}'s pinned cook footer sits
 * above the bottom of the screen, in points, so toasts can clear it.
 *
 * @param bottomInset - The bottom safe-area inset in points.
 */
export function cookFooterTop(bottomInset: number) {
  return bottomInset + FOOTER_BOTTOM_GAP + COOK_BUTTON_HEIGHT + FOOTER_TOP_PADDING;
}

type RecipeViewProps = {
  /** The recipe to show. */
  recipe: RecipeSuggestion;
  /** Whether the household has saved this recipe, which fills the bookmark. */
  isSaved: boolean;
  /** Disables the bookmark while a save or unsave is in flight. */
  isSavePending: boolean;
  /** Called when the bookmark is pressed, with the recipe and its saved state before the press. */
  onToggleSave: (recipe: RecipeSuggestion, saved: boolean) => void;
  /** Called when the close button is pressed. */
  onClose: () => void;
  /** True when this recipe is the active cook, which pins "Done cooking". */
  cooking: boolean;
  /** Disables the pinned cook button while a start or finish is in flight. */
  cookPending: boolean;
  /** Called by "Cook this" when `cooking` is false. */
  onCook: (recipe: RecipeSuggestion) => void;
  /** Called by "Done cooking" when `cooking` is true. */
  onDoneCooking: () => void;
};

type RecipeDetailProps = Omit<RecipeViewProps, "recipe"> & {
  recipe: RecipeSuggestion | null;
};

/**
 * Shows {@link RecipeView} in a full-screen modal with its own toast host.
 * The modal is visible while `recipe` is not `null`.
 */
export default function RecipeDetail({ recipe, ...props }: RecipeDetailProps) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal
      visible={recipe !== null}
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={props.onClose}
    >
      {recipe && (
        <>
          {/* Keyed so each recipe starts with a fresh scroll position. */}
          <RecipeView key={recipe.recipe_id} recipe={recipe} {...props} />
          <ToastHost bottomInset={cookFooterTop(insets.bottom)} />
        </>
      )}
    </Modal>
  );
}

/** Full-screen recipe with a pinned cook action, shared by detail and the active cook screen. */
export function RecipeView({
  recipe,
  isSaved,
  isSavePending,
  onToggleSave,
  onClose,
  cooking,
  cookPending,
  onCook,
  onDoneCooking,
}: RecipeViewProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const twoColumns = width >= 360 && fontScale < 1.6;
  const footerPadding = insets.bottom + FOOTER_BOTTOM_GAP;
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
        contentContainerStyle={{ paddingBottom: footerPadding + 96 }}
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
                      <FoodPhoto
                        foodId={item.inventory_item_id}
                        size={28}
                        enabled
                      />
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
                          {formatIngredientAmount(item)}
                        </Text>{" "}
                        {item.name}
                        {isKitchenBasic(item) ? (
                          <Text style={{ color: colors.textSubtle }}>
                            {" · kitchen basic"}
                          </Text>
                        ) : null}
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
      <View
        style={[
          styles.footer,
          {
            paddingBottom: footerPadding,
            backgroundColor: colors.bg,
            borderColor: colors.border,
          },
        ]}
      >
        <RecipePressable
          disabled={cookPending}
          onPress={() => (cooking ? onDoneCooking() : onCook(recipe))}
          accessibilityRole="button"
          accessibilityState={{ disabled: cookPending }}
          testID="recipe-cook-action"
          style={[
            styles.cookButton,
            {
              backgroundColor: colors.accent,
              opacity: cookPending ? 0.6 : 1,
            },
          ]}
        >
          {cooking ? (
            <Feather name="check" size={18} color={colors.accentInk} />
          ) : (
            <Ionicons name="flame" size={18} color={colors.accentInk} />
          )}
          <Text
            style={{
              color: colors.accentInk,
              fontFamily: fonts.bodyStrong,
              fontSize: 16,
            }}
          >
            {cooking ? "Done cooking" : "Cook this"}
          </Text>
        </RecipePressable>
      </View>
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
    alignItems: "center",
    gap: 10,
  },
  ingredientColumn: { flex: 1, minWidth: 0 },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: FOOTER_TOP_PADDING,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cookButton: {
    minHeight: COOK_BUTTON_HEIGHT,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
});
