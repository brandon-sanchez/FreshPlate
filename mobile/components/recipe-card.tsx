import { memo, useEffect, useRef, useState } from "react";
import { Animated as NativeAnimated, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import RecipeActionButton from "@/components/recipe-action-button";
import RecipePhoto from "@/components/recipe-photo";
import { RecipeActivity, RecipePressable } from "@/components/recipe-motion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";

const RecipeCard = memo(function RecipeCard({
  recipe,
  photoEnabled,
  stride,
  cardHeight,
  cardWidth,
  reducedMotion,
  largeText,
  compact,
  revealed,
  animatedIds,
  onDismiss,
  onIngredients,
  saved,
  onToggleSave,
  isSavePending,
}: {
  recipe: RecipeSuggestion;
  photoEnabled: boolean;
  stride: number;
  cardHeight: number;
  cardWidth: number;
  reducedMotion: boolean;
  largeText: boolean;
  compact: boolean;
  revealed: boolean;
  animatedIds: Set<string>;
  onDismiss: (recipeId: string) => void;
  onIngredients: (recipe: RecipeSuggestion) => void;
  saved: boolean;
  onToggleSave: (recipe: RecipeSuggestion, saved: boolean) => void;
  isSavePending: boolean;
}) {
  const { colors, fonts } = useTheme();
  const [isDismissing, setIsDismissing] = useState(false);
  const dismissalStarted = useRef(false);
  const startsAtRest = useRef(
    reducedMotion || animatedIds.has(recipe.recipe_id),
  ).current;
  const entryOpacity = useRef(
    new NativeAnimated.Value(startsAtRest ? 1 : 0.45),
  ).current;
  const entryY = useRef(
    new NativeAnimated.Value(startsAtRest ? 0 : 24),
  ).current;
  const opacity = useRef(new NativeAnimated.Value(1)).current;
  const dismissY = useRef(new NativeAnimated.Value(0)).current;
  useEffect(() => {
    if (reducedMotion) {
      entryOpacity.setValue(1);
      entryY.setValue(0);
      if (revealed) animatedIds.add(recipe.recipe_id);
      return;
    }
    if (!revealed || animatedIds.has(recipe.recipe_id)) return;
    animatedIds.add(recipe.recipe_id);
    const animation = NativeAnimated.parallel([
      NativeAnimated.timing(entryOpacity, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
        isInteraction: false,
      }),
      NativeAnimated.spring(entryY, {
        toValue: 0,
        stiffness: 240,
        damping: 26,
        mass: 0.7,
        useNativeDriver: true,
        isInteraction: false,
      }),
    ]);
    animation.start();
    return () => {
      animation.stop();
      entryOpacity.setValue(1);
      entryY.setValue(0);
    };
  }, [
    animatedIds,
    entryOpacity,
    entryY,
    recipe.recipe_id,
    reducedMotion,
    revealed,
  ]);
  useEffect(
    () => () => {
      opacity.stopAnimation();
      dismissY.stopAnimation();
    },
    [dismissY, opacity],
  );
  const dismiss = () => {
    if (dismissalStarted.current) return;
    dismissalStarted.current = true;
    setIsDismissing(true);
    if (reducedMotion) {
      onDismiss(recipe.recipe_id);
      return;
    }
    NativeAnimated.parallel([
      NativeAnimated.timing(dismissY, {
        toValue: -48,
        duration: 260,
        useNativeDriver: true,
      }),
      NativeAnimated.timing(opacity, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        onDismiss(recipe.recipe_id);
      }
    });
  };
  return (
    <View style={{ height: stride, paddingHorizontal: 24 }}>
      <View>
        <NativeAnimated.View
          testID={"recipe-card-" + recipe.recipe_id}
          style={{ opacity: entryOpacity, transform: [{ translateY: entryY }] }}
        >
          <NativeAnimated.View
            style={[
              styles.card,
              {
                width: cardWidth,
                height: cardHeight,
                backgroundColor: colors.surface,
                opacity,
                transform: [{ translateY: dismissY }],
              },
            ]}
          >
            <View
              style={[
                styles.artwork,
                compact && { height: 104 },
                { backgroundColor: colors.accentSoft },
              ]}
            >
              <RecipePressable
                accessibilityRole="button"
                accessibilityLabel={`Preview ${recipe.title}`}
                testID={`recipe-card-preview-${recipe.recipe_id}`}
                onPress={() => onIngredients(recipe)}
                style={StyleSheet.absoluteFill}
              >
                <RecipePhoto
                  recipeId={recipe.recipe_id}
                  title={recipe.title}
                  variant="card"
                  enabled={photoEnabled}
                  style={StyleSheet.absoluteFill}
                />
              </RecipePressable>
              <RecipePressable
                onPress={() => onToggleSave(recipe, saved)}
                disabled={isSavePending}
                accessibilityRole="button"
                accessibilityLabel={
                  saved
                    ? "Remove " + recipe.title + " from saved recipes"
                    : "Save " + recipe.title + " to household cookbook"
                }
                testID={"recipe-card-save-" + recipe.recipe_id}
                style={[styles.saveButton, { backgroundColor: colors.surface }]}
              >
                {saved ? (
                  <FontAwesome
                    name="bookmark"
                    size={19}
                    color={colors.accent}
                  />
                ) : (
                  <Feather name="bookmark" size={19} color={colors.textMuted} />
                )}
                <Text
                  style={{
                    color: saved ? colors.accent : colors.textMuted,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 12,
                  }}
                >
                  {saved ? "Saved" : "Save"}
                </Text>
              </RecipePressable>
            </View>
            <View
              style={[styles.cardContent, compact && { padding: 16, gap: 8 }]}
            >
              <Text
                selectable
                numberOfLines={3}
                onPress={() => onIngredients(recipe)}
                accessibilityRole="link"
                style={{
                  fontFamily: fonts.display,
                  fontSize: compact ? 22 : 24,
                  lineHeight: compact ? 26 : 28,
                  letterSpacing: -0.5,
                  color: colors.text,
                }}
              >
                {recipe.title}
              </Text>
              <View style={styles.facts}>
                <Text
                  style={{
                    color: colors.textMuted,
                    fontFamily: fonts.body,
                    fontSize: 13,
                  }}
                >
                  {recipe.servings} servings
                </Text>
                <Text style={{ color: colors.textSubtle, fontSize: 13 }}>
                  ·
                </Text>
                <Feather name="clock" size={14} color={colors.textMuted} />
                <Text
                  style={{
                    color: colors.textMuted,
                    fontFamily: fonts.body,
                    fontSize: 13,
                  }}
                >
                  {recipe.cook_time_minutes} min
                </Text>
              </View>
              <View style={{ gap: 5, flex: 1 }}>
                <Text
                  style={{
                    color: colors.textMuted,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 12,
                  }}
                >
                  Ingredients
                </Text>
                <Text
                  selectable
                  numberOfLines={2}
                  style={{
                    color: colors.text,
                    fontFamily: fonts.body,
                    fontSize: 14,
                    lineHeight: 21,
                  }}
                >
                  {recipe.ingredients
                    .map((ingredient) => ingredient.name)
                    .join(" · ")}
                </Text>
                {recipe.saves_expiring.length > 0 && (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: colors.warn,
                      fontFamily: fonts.body,
                      fontSize: 12,
                      marginTop: 3,
                    }}
                  >
                    Uses up {recipe.saves_expiring.join(", ")}
                  </Text>
                )}
              </View>
              <View
                style={[
                  styles.actions,
                  { borderColor: colors.border },
                  largeText && {
                    flexDirection: "column",
                    alignItems: "stretch",
                    gap: 4,
                  },
                ]}
              >
                <RecipeActionButton
                  label="Not this"
                  variant="secondary"
                  onPress={dismiss}
                  disabled={isDismissing}
                  testID={"recipe-card-not-this-" + recipe.recipe_id}
                  accessibilityLabel={"Not this: " + recipe.title}
                  style={{
                    minHeight: 48,
                    paddingHorizontal: 24,
                    flex: largeText ? undefined : 1,
                  }}
                />
                <RecipePressable
                  onPress={() => onIngredients(recipe)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    "View all " +
                    recipe.ingredients.length +
                    " ingredients for " +
                    recipe.title
                  }
                  testID={"recipe-card-ingredients-" + recipe.recipe_id}
                  style={{
                    minHeight: 48,
                    paddingHorizontal: 6,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                  }}
                >
                  <Text
                    style={{
                      color: colors.text,
                      fontFamily: fonts.bodyStrong,
                      fontSize: 12,
                    }}
                  >
                    Ingredients
                  </Text>
                  <Feather
                    name="arrow-up-right"
                    size={17}
                    color={colors.accent}
                  />
                </RecipePressable>
              </View>
            </View>
          </NativeAnimated.View>
        </NativeAnimated.View>
      </View>
    </View>
  );
});

export function RecipeSkeletonCard({
  cardHeight,
  reducedMotion,
  compact,
}: {
  cardHeight: number;
  reducedMotion: boolean;
  compact: boolean;
}) {
  const { colors, fonts } = useTheme();
  const opacity = useRef(new NativeAnimated.Value(0.55)).current;
  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(0.65);
      return;
    }
    const animation = NativeAnimated.loop(
      NativeAnimated.sequence([
        NativeAnimated.timing(opacity, {
          toValue: 0.9,
          duration: 850,
          useNativeDriver: true,
          isInteraction: false,
        }),
        NativeAnimated.timing(opacity, {
          toValue: 0.45,
          duration: 850,
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity, reducedMotion]);
  return (
    <View
      testID="recipe-feed-loading"
      accessibilityRole="progressbar"
      accessibilityLabel="Finding more recipes"
      accessibilityState={{ busy: true }}
      style={{ paddingHorizontal: 24 }}
    >
      <View
        style={[
          styles.card,
          { height: cardHeight, backgroundColor: colors.surface },
        ]}
      >
        <View
          style={[
            styles.artwork,
            compact && { height: 104 },
            { backgroundColor: colors.surfaceAlt },
          ]}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <RecipeActivity reducedMotion={reducedMotion} />
            <Text
              style={{
                color: colors.textMuted,
                fontFamily: fonts.body,
                fontSize: 13,
              }}
            >
              Finding a few more ideas
            </Text>
          </View>
        </View>
        <NativeAnimated.View
          testID="recipe-feed-skeleton"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.cardContent,
            compact && { padding: 16, gap: 8 },
            { opacity },
          ]}
        >
          {(["85%", "62%", "45%", "90%", "70%"] as const).map(
            (lineWidth, index) => (
              <View
                key={lineWidth}
                style={{
                  backgroundColor: colors.surfaceAlt,
                  height: index < 2 ? 23 : 12,
                  borderRadius: 6,
                  width: lineWidth,
                  marginBottom: 5,
                }}
              />
            ),
          )}
          <View
            style={{
              marginTop: "auto",
              height: 48,
              width: "48%",
              borderRadius: 24,
              backgroundColor: colors.surfaceAlt,
            }}
          />
        </NativeAnimated.View>
      </View>
    </View>
  );
}

export default RecipeCard;

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    borderCurve: "continuous",
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(27,31,28,0.07)",
  },
  artwork: { height: 164 },
  cardContent: { flex: 1, padding: 20, gap: 12 },
  facts: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
  },
  saveButton: {
    position: "absolute",
    right: 14,
    top: 14,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.82)",
    zIndex: 2,
  },
});
