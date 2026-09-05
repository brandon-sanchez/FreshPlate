import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  LayoutAnimation,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { RecipeActivity, RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type {
  RecipePreferences,
  RecipeSuggestion,
} from "@/types/recipes";
import { RecipeContextBar, RecipeScreenHeader } from "@/components/recipe-screen-header";

const RECIPE_FEED_ENTRY_BATCH_SIZE = 8;
const RECIPE_FEED_ENTRY_STAGGER_MS = 35;

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
};

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
}: RecipeFeedProps) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const [revealedIds, setRevealedIds] = useState(new Set<string>());
  const animatedIds = useRef(new Set<string>()).current;
  const recipesRef = useRef(recipes);
  const lastVisibleIndexRef = useRef(-1);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const onNearEndRef = useRef(onNearEnd);
  useEffect(() => {
    onNearEndRef.current = onNearEnd;
    recipesRef.current = recipes;
  }, [onNearEnd, recipes]);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const indexes = viewableItems
        .map((item) => item.index)
        .filter((index): index is number => index !== null);
      if (indexes.length > 0) {
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
      }
    },
  ).current;
  const dismissRecipe = useCallback((recipeId: string) => {
    const index = recipesRef.current.findIndex((recipe) => recipe.recipe_id === recipeId);
    onDismiss(recipeId);
    onNearEndRef.current(index);
  }, [onDismiss]);
  const renderItem = useCallback(
    ({ item, index }: { item: RecipeSuggestion; index: number }) => (
      <RecipeFeedCard
        recipe={item}
        entryIndex={index % 3}
        revealed={revealedIds.has(item.recipe_id)}
        animatedIds={animatedIds}
        reducedMotion={reducedMotion}
        onDismiss={dismissRecipe}
      />
    ),
    [animatedIds, dismissRecipe, reducedMotion, revealedIds],
  );

  const footer = isPrefetching ? (
    <RecipeLoadingTail reducedMotion={reducedMotion} />
  ) : prefetchError ? (
    <RecipeFeedMoreError hasRecipes={recipes.length > 0} onRetry={onRetryMore} />
  ) : isExhausted && recipes.length > 0 ? (
    <RecipeFeedTerminator hasRecipes onAddItems={onAddItems} onEditAnswers={onEditAnswers} />
  ) : <View style={styles.footerSpace} />;

  return (
    <FlatList
      data={recipes}
      keyExtractor={(recipe) => recipe.recipe_id}
      renderItem={renderItem}
      ItemSeparatorComponent={FeedSeparator}
      ListHeaderComponent={
        <View>
          <RecipeScreenHeader subtitle="Generated for this moment" />
          <RecipeContextBar
            itemCount={itemCount}
            preferences={preferences}
            onAsk={onAsk}
          />
        </View>
      }
      ListEmptyComponent={
        isExhausted ? (
          <RecipeFeedTerminator
            hasRecipes={false}
            onAddItems={onAddItems}
            onEditAnswers={onEditAnswers}
          />
        ) : null
      }
      ListFooterComponent={footer}
      extraData={revealedIds}
      onEndReached={() => onNearEnd(lastVisibleIndexRef.current)}
      onEndReachedThreshold={2}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={viewabilityConfig}
      initialNumToRender={RECIPE_FEED_ENTRY_BATCH_SIZE}
      maxToRenderPerBatch={RECIPE_FEED_ENTRY_BATCH_SIZE}
      updateCellsBatchingPeriod={16}
      windowSize={9}
      contentInsetAdjustmentBehavior="never"
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: topInset + 12,
        paddingBottom: bottomInset,
      }}
      testID="recipe-feed-list"
    />
  );
}

function FeedSeparator() {
  return <View style={styles.separator} />;
}

const RecipeFeedCard = memo(function RecipeFeedCard({
  recipe,
  entryIndex,
  revealed,
  animatedIds,
  reducedMotion,
  onDismiss,
}: {
  recipe: RecipeSuggestion;
  entryIndex: number;
  revealed: boolean;
  animatedIds: Set<string>;
  reducedMotion: boolean;
  onDismiss: (recipeId: string) => void;
}) {
  const { colors, fonts } = useTheme();
  const [isDismissing, setIsDismissing] = useState(false);
  const startsAtRest = useRef(reducedMotion || animatedIds.has(recipe.recipe_id)).current;
  const entryOpacity = useRef(new Animated.Value(startsAtRest ? 1 : 0.45)).current;
  const entryTranslateY = useRef(new Animated.Value(startsAtRest ? 0 : 22)).current;
  const entryScale = useRef(new Animated.Value(startsAtRest ? 1 : 0.985)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const entryDelay = useRef(entryIndex * RECIPE_FEED_ENTRY_STAGGER_MS).current;

  useEffect(() => {
    // FlatList mounts offscreen cells ahead of the viewport. Reveal only when
    // first seen, and remember IDs across virtualization and list growth.
    if (reducedMotion) {
      entryOpacity.setValue(1);
      entryTranslateY.setValue(0);
      entryScale.setValue(1);
      if (revealed) animatedIds.add(recipe.recipe_id);
      return;
    }
    if (!revealed || animatedIds.has(recipe.recipe_id)) return;
    animatedIds.add(recipe.recipe_id);
    const animation = Animated.parallel([
      Animated.timing(entryOpacity, {
        toValue: 1, duration: 260, delay: entryDelay,
        useNativeDriver: true, isInteraction: false,
      }),
      Animated.spring(entryTranslateY, {
        toValue: 0, stiffness: 240, damping: 26, mass: 0.7,
        delay: entryDelay, useNativeDriver: true, isInteraction: false,
      }),
      Animated.timing(entryScale, {
        toValue: 1, duration: 320, delay: entryDelay,
        useNativeDriver: true, isInteraction: false,
      }),
    ]);
    animation.start();
    return () => {
      animation.stop();
      entryOpacity.setValue(1);
      entryTranslateY.setValue(0);
      entryScale.setValue(1);
    };
  }, [animatedIds, entryDelay, entryOpacity, entryScale, entryTranslateY, recipe.recipe_id, reducedMotion, revealed]);

  const dismiss = () => {
    if (isDismissing) return;
    setIsDismissing(true);
    if (reducedMotion) {
      onDismiss(recipe.recipe_id);
      return;
    }
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -26,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        onDismiss(recipe.recipe_id);
      }
    });
  };

  return (
    <Animated.View
      testID={`recipe-card-${recipe.recipe_id}`}
      style={{
        opacity: entryOpacity,
        transform: [
          { translateY: entryTranslateY },
          { scale: entryScale },
        ],
      }}
    >
      <Animated.View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.border },
        { opacity, transform: [{ translateY }] },
      ]}
      >
      <View style={styles.cardTopRow}>
        <View style={[styles.generatedPill, { backgroundColor: colors.accentSoft }]}>
          <Feather name="zap" size={12} color={colors.accent} />
          <Text style={[styles.generatedText, { color: colors.accent, fontFamily: fonts.bodyStrong }]}>
            Generated
          </Text>
        </View>
        {recipe.saves_expiring.length > 0 ? (
          <View style={[styles.savesPill, { backgroundColor: colors.surfaceAlt }]}>
            <Text style={[styles.savesText, { color: colors.warn, fontFamily: fonts.bodyStrong }]}>
              Saves {recipe.saves_expiring[0]}
            </Text>
          </View>
        ) : null}
      </View>

      <Text
        selectable
        style={[styles.title, { color: colors.text, fontFamily: fonts.display }]}
      >
        {recipe.title}
      </Text>

      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Feather name="clock" size={13} color={colors.textMuted} />
          <Text style={[styles.statText, { color: colors.textMuted, fontFamily: fonts.body }]}>
            {recipe.cook_time_minutes} min
          </Text>
        </View>
        <Text
          selectable
          style={[styles.matchText, { color: colors.accent, fontFamily: fonts.bodyStrong }]}
        >
          {recipe.match_percent}% match
        </Text>
      </View>

      <View style={[styles.actionRow, { borderTopColor: colors.border }]}>
        <RecipePressable
          onPress={dismiss}
          disabled={isDismissing}
          testID={`recipe-card-not-this-${recipe.recipe_id}`}
          accessibilityRole="button"
          accessibilityLabel={`Not this: ${recipe.title}`}
          style={[styles.dismissButton, { backgroundColor: colors.surfaceAlt }]}
        >
          <Feather name="x" size={14} color={colors.textMuted} />
          <Text style={[styles.dismissText, { color: colors.textMuted, fontFamily: fonts.bodyStrong }]}>
            Not this
          </Text>
        </RecipePressable>
      </View>
      </Animated.View>
    </Animated.View>
  );
});

function RecipeLoadingTail({ reducedMotion }: { reducedMotion: boolean }) {
  const { colors, fonts } = useTheme();
  return (
    <View testID="recipe-feed-loading" accessibilityRole="progressbar"
      accessibilityLabel="Finding more recipes" accessibilityState={{ busy: true }}
      style={[styles.loadingTail, { borderColor: colors.border }]}>
      <RecipeActivity reducedMotion={reducedMotion} />
      <Text style={{ color: colors.textMuted, fontFamily: fonts.body, fontSize: 13 }}>
        Finding a few more ideas
      </Text>
      <Text style={{ color: colors.textMuted, fontFamily: fonts.body, fontSize: 12 }}>
        You can keep browsing above
      </Text>
    </View>
  );
}

function RecipeFeedMoreError({
  hasRecipes,
  onRetry,
}: {
  hasRecipes: boolean;
  onRetry: () => void;
}) {
  const { colors, fonts } = useTheme();

  return (
    <View
      testID="recipe-feed-more-error"
      style={[styles.moreError, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Text style={[styles.moreErrorText, { color: colors.textMuted, fontFamily: fonts.body }]}>
        {hasRecipes
          ? "We couldn't load more recipes right now."
          : "We couldn't load recipes right now."}
      </Text>
      <RecipePressable
        onPress={onRetry}
        testID="recipe-feed-more-retry"
        accessibilityRole="button"
        style={[styles.retryButton, { borderColor: colors.border }]}
      >
        <Text style={[styles.retryText, { color: colors.text, fontFamily: fonts.bodyStrong }]}>
          Try again
        </Text>
      </RecipePressable>
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
    <View
      testID="recipe-feed-exhausted"
      style={[styles.terminator, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.terminatorIcon, { backgroundColor: colors.accentSoft }]}>
        <Feather name="check" size={18} color={colors.accent} />
      </View>
      <Text style={[styles.terminatorTitle, { color: colors.text, fontFamily: fonts.display }]}>
        {hasRecipes ? "That's all for now" : "Nothing fits this kitchen yet"}
      </Text>
      <Text style={[styles.terminatorText, { color: colors.textMuted, fontFamily: fonts.body }]}>
        {hasRecipes
          ? "You've explored this set of recipe ideas. Add ingredients or edit your answers for a fresh set."
          : "Your inventory can't support a coherent recipe yet. Try adding an item or changing the answers for this session."}
      </Text>
      <View style={styles.terminatorActions}>
        <RecipePressable
          onPress={onAddItems}
          testID="recipe-feed-add-items"
          accessibilityRole="button"
          style={[styles.primaryTerminatorButton, { backgroundColor: colors.accent }]}
        >
          <Text style={[styles.primaryTerminatorText, { color: colors.accentInk, fontFamily: fonts.bodyStrong }]}>
            Add items
          </Text>
        </RecipePressable>
        <RecipePressable
          onPress={onEditAnswers}
          testID="recipe-feed-edit-answers"
          accessibilityRole="button"
          style={[styles.secondaryTerminatorButton, { borderColor: colors.border }]}
        >
          <Text style={[styles.secondaryTerminatorText, { color: colors.text, fontFamily: fonts.bodyStrong }]}>
            Edit answers
          </Text>
        </RecipePressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  separator: {
    height: 14,
  },
  loadingTail: { marginHorizontal: 24, marginTop: 18, minHeight: 126, alignItems: "center", justifyContent: "center", gap: 7, borderTopWidth: StyleSheet.hairlineWidth },
  footerSpace: {
    height: 24,
  },
  card: {
    marginHorizontal: 16,
    padding: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOpacity: 0.045,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 28,
    flexWrap: "wrap",
  },
  generatedPill: {
    minHeight: 26,
    paddingHorizontal: 9,
    borderRadius: 100,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  generatedText: {
    fontSize: 12,
    letterSpacing: 0.3,
  },
  savesPill: {
    minHeight: 26,
    paddingHorizontal: 9,
    borderRadius: 100,
    justifyContent: "center",
  },
  savesText: {
    fontSize: 12,
  },
  title: {
    fontSize: 23,
    lineHeight: 29,
    letterSpacing: -0.5,
    marginTop: 16,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 14,
  },
  stat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  statText: {
    fontSize: 12,
  },
  matchText: {
    fontSize: 12,
  },
  actionRow: {
    borderTopWidth: 1,
    marginTop: 18,
    paddingTop: 14,
    alignItems: "flex-start",
  },
  dismissButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 100,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  dismissText: {
    fontSize: 12,
  },
  moreError: {
    marginHorizontal: 16,
    padding: 16,
    borderWidth: 1,
    borderRadius: 16,
    alignItems: "center",
    gap: 10,
  },
  moreErrorText: {
    fontSize: 13,
  },
  retryButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 100,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: {
    fontSize: 12,
  },
  terminator: {
    marginHorizontal: 16,
    marginTop: 18,
    padding: 24,
    borderWidth: 1,
    borderRadius: 18,
    alignItems: "center",
    gap: 8,
  },
  terminatorIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 3,
  },
  terminatorTitle: {
    fontSize: 19,
    letterSpacing: -0.3,
    textAlign: "center",
  },
  terminatorText: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    maxWidth: 290,
  },
  terminatorActions: {
    width: "100%",
    gap: 8,
    marginTop: 8,
  },
  primaryTerminatorButton: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryTerminatorText: {
    fontSize: 13,
  },
  secondaryTerminatorButton: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryTerminatorText: {
    fontSize: 13,
  },
});
