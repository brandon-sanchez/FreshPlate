import { Modal, PanResponder, ScrollView, Text, View } from "react-native";
import { useRef } from "react";
import Feather from "@expo/vector-icons/Feather";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";
import FoodPhoto from "@/components/food-photo";
import RecipePhoto from "@/components/recipe-photo";
import RecipeStats from "@/components/recipe-stats";
import RecipeSteps from "@/components/recipe-steps";
import { formatIngredientAmount } from "@/lib/recipe-format";

type RecipeIngredientsSheetProps = {
  /** The recipe to preview; `null` hides the sheet. */
  recipe: RecipeSuggestion | null;
  /** Called when the user dismisses the sheet, and before it opens the full recipe or a cook. */
  onClose: () => void;
  /** Opens the full recipe after a drag up on the handle or its accessibility action. */
  onOpenDetail?: (recipe: RecipeSuggestion) => void;
  /** Starts a cook of `recipe` from the "Cook this" button, after the sheet closes. */
  onCook: (recipe: RecipeSuggestion) => void;
};

/**
 * A bottom sheet that previews a recipe's ingredients and steps. Its primary
 * button starts a cook, and dragging the handle up opens the full recipe.
 */
export default function RecipeIngredientsSheet({
  recipe,
  onClose,
  onOpenDetail,
  onCook,
}: RecipeIngredientsSheetProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const startY = useRef(0);
  const recipeRef = useRef(recipe);
  recipeRef.current = recipe;
  const onCloseRef = useRef(onClose);
  const onOpenDetailRef = useRef(onOpenDetail);
  onCloseRef.current = onClose;
  onOpenDetailRef.current = onOpenDetail;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        startY.current = event.nativeEvent.pageY;
      },
      onPanResponderRelease: (event) => {
        const currentRecipe = recipeRef.current;
        if (startY.current - event.nativeEvent.pageY > 48 && currentRecipe) {
          onCloseRef.current();
          onOpenDetailRef.current?.(currentRecipe);
        }
      },
    }),
  ).current;
  return (
    <Modal
      visible={recipe !== null}
      transparent
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: "rgba(0,0,0,0.25)",
        }}
      >
        <RecipePressable
          accessibilityLabel="Close ingredients"
          onPress={onClose}
          style={{ flex: 1 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: "80%",
            backgroundColor: colors.surface,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingBottom: insets.bottom + 20,
          }}
        >
          <View
            {...panResponder.panHandlers}
            testID="recipe-preview-drag-handle"
            accessible
            accessibilityRole="button"
            accessibilityLabel="View full recipe"
            accessibilityHint="Drag up to expand the recipe"
            accessibilityActions={[{ name: "activate" }]}
            onAccessibilityAction={() => {
              if (!recipe) return;
              onClose();
              onOpenDetail?.(recipe);
            }}
            style={{
              alignSelf: "center",
              width: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              marginTop: 10,
            }}
          >
            <View
              style={{
                width: 44,
                height: 6,
                borderRadius: 3,
                backgroundColor: colors.border,
              }}
            />
          </View>
          <View style={{ padding: 24, gap: 12 }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  color: colors.accent,
                  fontSize: 13,
                }}
              >
                Ingredients
              </Text>
              <RecipePressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close ingredients"
                testID="recipe-ingredients-close"
                style={{
                  width: 44,
                  height: 44,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Feather name="x" size={22} color={colors.text} />
              </RecipePressable>
            </View>
          </View>
          <ScrollView
            testID="recipe-ingredients-list"
            contentContainerStyle={{ paddingHorizontal: 24 }}
          >
            <View style={{ gap: 12, paddingBottom: 20 }}>
              {recipe && (
                <RecipePhoto
                  recipeId={recipe.recipe_id}
                  title={recipe.title}
                  variant="sheet"
                  style={{ height: 180, borderRadius: 18 }}
                />
              )}
              <Text
                selectable
                style={{
                  fontFamily: fonts.display,
                  color: colors.text,
                  fontSize: 26,
                  lineHeight: 32,
                }}
              >
                {recipe?.title}
              </Text>
              {recipe && <RecipeStats recipe={recipe} />}
            </View>
            {recipe?.ingredients.map((ingredient, index) => (
              <View
                key={`${ingredient.name}-${index}`}
                style={{
                  paddingVertical: 10,
                  gap: 12,
                  borderTopWidth: 0.5,
                  borderColor: colors.border,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                <FoodPhoto
                  foodId={ingredient.inventory_item_id}
                  size={36}
                  enabled
                />
                <View style={{ flex: 1, gap: 5 }}>
                  <Text
                    selectable
                    style={{
                      fontFamily: fonts.bodyStrong,
                      color: colors.text,
                      fontSize: 15,
                    }}
                  >
                    {ingredient.name}
                  </Text>
                </View>
                <Text
                  selectable
                  style={{
                    fontFamily: fonts.body,
                    color: colors.text,
                    fontSize: 14,
                  }}
                >
                  {formatIngredientAmount(ingredient)}
                </Text>
              </View>
            ))}
            <Text
              style={{
                color: colors.textMuted,
                fontFamily: fonts.bodyStrong,
                fontSize: 13,
                marginTop: 12,
                marginBottom: 8,
              }}
            >
              STEPS
            </Text>
            {recipe && <RecipeSteps steps={recipe.steps} />}
          </ScrollView>
          {recipe && (
            <RecipePressable
              onPress={() => {
                onClose();
                onCook(recipe);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Cook ${recipe.title}`}
              testID="recipe-preview-cook"
              style={{
                margin: 20,
                minHeight: 52,
                borderRadius: 16,
                backgroundColor: colors.accent,
                flexDirection: "row",
                gap: 10,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="flame" size={18} color={colors.accentInk} />
              <Text
                style={{
                  color: colors.accentInk,
                  fontFamily: fonts.bodyStrong,
                  fontSize: 16,
                }}
              >
                Cook this
              </Text>
            </RecipePressable>
          )}
        </View>
      </View>
    </Modal>
  );
}
