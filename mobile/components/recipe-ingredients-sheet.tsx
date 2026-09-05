import { Modal, ScrollView, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";

export default function RecipeIngredientsSheet({
  recipe,
  onClose,
}: {
  recipe: RecipeSuggestion | null;
  onClose: () => void;
}) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
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
          <ScrollView
            testID="recipe-ingredients-list"
            contentContainerStyle={{ paddingHorizontal: 24 }}
          >
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
                  <Text
                    style={{
                      fontFamily: fonts.body,
                      color: colors.textMuted,
                      fontSize: 12,
                    }}
                  >
                    {ingredient.inventory_item_id
                      ? "From your kitchen"
                      : "Check your pantry"}
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
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
