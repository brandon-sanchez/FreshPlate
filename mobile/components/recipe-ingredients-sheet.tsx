import { Modal, PanResponder, ScrollView, Text, View } from "react-native";
import { useRef } from "react";
import Feather from "@expo/vector-icons/Feather";
import Ionicons from "@expo/vector-icons/Ionicons";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";
import RecipeSteps from "@/components/recipe-steps";

export default function RecipeIngredientsSheet({
  recipe,
  onClose,
  onOpenDetail,
  onCook,
}: {
  recipe: RecipeSuggestion | null;
  onClose: () => void;
  onOpenDetail?: (recipe: RecipeSuggestion) => void;
  onCook: (recipe: RecipeSuggestion) => void;
}) {
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
              <View
                testID="recipe-preview-artwork"
                style={{
                  height: 132,
                  borderRadius: 18,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.accentSoft,
                }}
              >
                <FontAwesome name="cutlery" size={48} color={colors.accent} />
              </View>
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
              <Text
                style={{
                  fontFamily: fonts.body,
                  color: colors.textMuted,
                  fontSize: 13,
                }}
              >
                {recipe?.cook_time_minutes} min · {recipe?.servings} servings
              </Text>
            </View>
            {recipe?.ingredients.map((ingredient, index) => (
              <View
                key={`${ingredient.name}-${index}`}
                style={{
                  paddingVertical: 16,
                  gap: 8,
                  borderTopWidth: 0.5,
                  borderColor: colors.border,
                  flexDirection: "row",
                  alignItems: "flex-start",
                }}
              >
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
                  {Number(ingredient.use_amount.toFixed(2))} {ingredient.unit}
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
              onPress={() => onCook(recipe)}
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
