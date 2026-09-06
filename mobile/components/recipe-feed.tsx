import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Animated as NativeAnimated,
  FlatList,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ViewToken,
} from "react-native";
import type { ReactNode } from "react";
import Animated, { Easing, LinearTransition } from "react-native-reanimated";
import Feather from "@expo/vector-icons/Feather";
import RecipeCarousel from "@/components/recipe-carousel";
import RecipeActionButton from "@/components/recipe-action-button";
import RecipeIngredientsSheet from "@/components/recipe-ingredients-sheet";
import { RecipeActivity, RecipePressable } from "@/components/recipe-motion";
import {
  RecipeContextBar,
  RecipeScreenHeader,
} from "@/components/recipe-screen-header";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipePreferences, RecipeSuggestion } from "@/types/recipes";

type RecipeFeedProps = {
  recipes: RecipeSuggestion[];
  itemCount: number;
  preferences: RecipePreferences;
  isPrefetching: boolean;
  prefetchError: Error | null;
  isExhausted: boolean;
  topInset: number;
  bottomInset: number;
  onAsk: () => void;
  onDismiss: (recipeId: string) => void;
  onNearEnd: (lastVisibleIndex: number) => void;
  onRetryMore: () => void;
  onAddItems: () => void;
  onEditAnswers: () => void;
  savedIds?: Set<string>;
  onToggleSave?: (recipe: RecipeSuggestion, saved: boolean) => void;
  isSavePending?: boolean;
  header?: ReactNode;
};

const replacementTransition = LinearTransition.duration(360).easing(
  Easing.inOut(Easing.cubic),
);

export default function RecipeFeed({
  recipes,
  itemCount,
  preferences,
  isPrefetching,
  prefetchError,
  isExhausted,
  topInset,
  bottomInset,
  onAsk,
  onDismiss,
  onNearEnd,
  onRetryMore,
  onAddItems,
  onEditAnswers,
  savedIds = new Set<string>(),
  onToggleSave = () => undefined,
  isSavePending = false,
  header,
}: RecipeFeedProps) {
  const { colors } = useTheme();
  const { width, height, fontScale } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const fullCardHeight = Math.round(
    Math.min(530, Math.max(480, height * 0.53)) +
      Math.max(0, fontScale - 1) * 240,
  );
  const [listHeight, setListHeight] = useState(0);
  const stackCardHeight = Math.round(
    Math.min(440, Math.max(420, height * 0.45)) +
      Math.max(0, fontScale - 1) * 240,
  );
  const stackEnabled = fontScale <= 1.2 && listHeight >= stackCardHeight + 100;
  const cardHeight = stackEnabled ? stackCardHeight : fullCardHeight;
  const stride = cardHeight + 20;
  const listRef = useRef<FlatList<RecipeSuggestion>>(null);
  const [revealedIds, setRevealedIds] = useState(new Set<string>());
  const [ingredientRecipe, setIngredientRecipe] =
    useState<RecipeSuggestion | null>(null);
  const animatedIds = useRef(new Set<string>()).current;
  const recipesRef = useRef(recipes);
  const lastVisibleIndexRef = useRef(-1);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 15 }).current;
  const onNearEndRef = useRef(onNearEnd);
  useEffect(() => {
    recipesRef.current = recipes;
    onNearEndRef.current = onNearEnd;
  }, [recipes, onNearEnd]);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const indexes = viewableItems
        .map((item) => item.index)
        .filter((index): index is number => index !== null);
      if (!indexes.length) return;
      lastVisibleIndexRef.current = Math.max(...indexes);
      onNearEndRef.current(lastVisibleIndexRef.current);
      setRevealedIds((previous) => {
        const next = new Set(previous);
        for (const index of indexes) {
          const recipe = recipesRef.current[index];
          if (recipe) next.add(recipe.recipe_id);
        }
        return next.size === previous.size ? previous : next;
      });
    },
  ).current;
  const reportActiveRecipe = useCallback(
    (index: number) => {
      const recipeIndex = Math.min(index, recipes.length - 1);
      lastVisibleIndexRef.current = recipeIndex;
      onNearEnd(recipeIndex);
    },
    [onNearEnd, recipes.length],
  );
  const dismissRecipe = useCallback(
    (recipeId: string) => {
      const index = recipesRef.current.findIndex(
        (recipe) => recipe.recipe_id === recipeId,
      );
      onDismiss(recipeId);
      onNearEndRef.current(index);
    },
    [onDismiss],
  );
  const renderItem = useCallback(
    ({ item }: { item: RecipeSuggestion; index: number }) => (
      <RecipeCard
        recipe={item}
        stride={stride}
        cardHeight={cardHeight}
        cardWidth={width - 48}
        reducedMotion={reducedMotion}
        largeText={fontScale > 1.2}
        compact={stackEnabled}
        revealed={stackEnabled || revealedIds.has(item.recipe_id)}
        animatedIds={animatedIds}
        onDismiss={dismissRecipe}
        onIngredients={setIngredientRecipe}
        saved={savedIds.has(item.recipe_id)}
        onToggleSave={onToggleSave}
        isSavePending={isSavePending}
      />
    ),
    [
      animatedIds,
      cardHeight,
      dismissRecipe,
      stackEnabled,
      fontScale,
      reducedMotion,
      revealedIds,
      stride,
      width,
      onToggleSave,
      savedIds,
    ],
  );
  const footer = isPrefetching ? (
    <RecipeSkeletonCard
      cardHeight={cardHeight}
      reducedMotion={reducedMotion}
      compact={stackEnabled}
    />
  ) : prefetchError ? (
    <View style={styles.ending}>
      <Text style={[styles.message, { color: colors.textMuted }]}>
        {recipes.length
          ? "We couldn't load more recipes right now."
          : "We couldn't load recipes right now."}
      </Text>
      <RecipeActionButton
        label="Try again"
        onPress={onRetryMore}
        testID="recipe-feed-more-retry"
      />
    </View>
  ) : isExhausted ? (
    <RecipeFeedTerminator
      hasRecipes={recipes.length > 0}
      onAddItems={onAddItems}
      onEditAnswers={onEditAnswers}
    />
  ) : null;
  return (
    <View
      key={fontScale}
      style={{ flex: 1, backgroundColor: colors.bg, paddingTop: topInset + 8 }}
    >
      {header ?? <RecipeScreenHeader />}
      <RecipeContextBar
        itemCount={itemCount}
        preferences={preferences}
        onAsk={onAsk}
      />
      <View
        testID="recipe-feed-viewport"
        style={{ flex: 1, marginBottom: bottomInset + 8 }}
        onLayout={(event) => setListHeight(event.nativeEvent.layout.height)}
      >
        {stackEnabled ? (
          <RecipeCarousel
            cardHeight={cardHeight}
            reducedMotion={reducedMotion}
            onActiveIndexChange={reportActiveRecipe}
            items={[
              ...recipes.map((recipe, index) => ({
                id: recipe.recipe_id,
                isRecipe: true,
                content: renderItem({ item: recipe, index }),
              })),
              ...(footer
                ? [
                    {
                      id: "recipe-feed-tail",
                      isRecipe: false,
                      content: (
                        <View
                          style={{
                            height: cardHeight,
                            justifyContent: "center",
                            ...(!isPrefetching && {
                              marginHorizontal: 24,
                              borderRadius: 24,
                              backgroundColor: colors.surface,
                            }),
                          }}
                        >
                          {footer}
                        </View>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        ) : (
          <Animated.FlatList
            ref={listRef}
            data={recipes}
            keyExtractor={(recipe) => recipe.recipe_id}
            renderItem={renderItem}
            ListFooterComponent={footer}
            extraData={revealedIds}
            itemLayoutAnimation={
              reducedMotion ? undefined : replacementTransition
            }
            onEndReached={() => onNearEnd(lastVisibleIndexRef.current)}
            onEndReachedThreshold={2}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            initialNumToRender={4}
            maxToRenderPerBatch={4}
            windowSize={7}
            updateCellsBatchingPeriod={16}
            getItemLayout={(_, index) => ({
              index,
              length: stride,
              offset: stride * index,
            })}
            decelerationRate="normal"
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={false}
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={{ paddingTop: 8, paddingBottom: 20 }}
            testID="recipe-feed-list"
          />
        )}
      </View>
      <RecipeIngredientsSheet
        recipe={ingredientRecipe}
        onClose={() => setIngredientRecipe(null)}
      />
    </View>
  );
}

const RecipeCard = memo(function RecipeCard({
  recipe,
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
              accessibilityLabel="Recipe image placeholder"
              style={[
                styles.artwork,
                compact && { height: 104 },
                { backgroundColor: colors.accentSoft },
              ]}
            >
              <Feather
                name="image"
                size={34}
                color={colors.accent}
                style={{ opacity: 0.3 }}
              />
              <View style={styles.imageCaption}>
                <Feather name="zap" size={13} color={colors.accent} />
                <Text
                  style={{
                    color: colors.accent,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 12,
                  }}
                >
                  Generated
                </Text>
              </View>
            </View>
            <View
              style={[styles.cardContent, compact && { padding: 16, gap: 8 }]}
            >
              <Text
                selectable
                numberOfLines={3}
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
                <Text style={{ color: colors.textSubtle, fontSize: 13 }}>
                  ·
                </Text>
                <Text
                  style={{
                    color: colors.textMuted,
                    fontFamily: fonts.body,
                    fontSize: 13,
                  }}
                >
                  {recipe.servings} servings
                </Text>
                <Text
                  style={{
                    marginLeft: "auto",
                    color: colors.accent,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 12,
                  }}
                >
                  {recipe.match_percent}% match
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
                <RecipePressable
                  onPress={() => onToggleSave(recipe, saved)}
                  disabled={isSavePending}
                  accessibilityRole="button"
                  accessibilityLabel={saved ? `Remove ${recipe.title} from saved recipes` : `Save ${recipe.title} to household cookbook`}
                  testID={`recipe-card-save-${recipe.recipe_id}`}
                  style={styles.saveButton}
                >
                  <Feather name="bookmark" size={19} color={saved ? colors.accent : colors.textMuted} fill={saved ? colors.accent : "transparent"} />
                  <Text style={{ color: saved ? colors.accent : colors.textMuted, fontFamily: fonts.bodyStrong, fontSize: 12 }}>
                    {saved ? "Saved" : "Save"}
                  </Text>
                </RecipePressable>
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

function RecipeSkeletonCard({
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

function RecipeFeedTerminator({
  hasRecipes,
  onAddItems,
  onEditAnswers,
}: {
  hasRecipes: boolean;
  onAddItems: () => void;
  onEditAnswers: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View style={styles.ending}>
      <View
        style={{
          height: 1,
          width: 40,
          backgroundColor: colors.accent,
          marginBottom: 12,
        }}
      />
      <Text
        style={{
          fontFamily: fonts.display,
          fontSize: 28,
          color: colors.text,
          textAlign: "center",
        }}
      >
        {hasRecipes ? "That's all for now" : "A little more to work with"}
      </Text>
      <Text
        style={[
          styles.message,
          { fontFamily: fonts.body, color: colors.textMuted },
        ]}
      >
        {hasRecipes
          ? "You've explored this set of recipe ideas. Add ingredients or edit your answers for a fresh set."
          : "Your inventory can't support a coherent recipe yet. Add an ingredient or change your answers."}
      </Text>
      <RecipeActionButton
        label="Add items"
        onPress={onAddItems}
        testID="recipe-feed-add-items"
        style={{ alignSelf: "stretch" }}
      />
      <RecipeActionButton
        label="Edit answers"
        variant="secondary"
        onPress={onEditAnswers}
        testID="recipe-feed-edit-answers"
        style={{ alignSelf: "stretch" }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    borderCurve: "continuous",
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(27,31,28,0.07)",
  },
  artwork: { height: 164, alignItems: "center", justifyContent: "center" },
  imageCaption: {
    position: "absolute",
    bottom: 14,
    left: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
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
  ending: {
    marginHorizontal: 32,
    paddingVertical: 32,
    alignItems: "center",
    gap: 16,
  },
  message: { fontSize: 14, lineHeight: 22, textAlign: "center" },
});
