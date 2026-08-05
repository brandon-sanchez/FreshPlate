import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useTheme } from "@/hooks/useTheme";
import type {
  RecipePreferences,
  RecipeSuggestion,
} from "@/types/recipes";
import { RecipeContextBar, RecipeScreenHeader } from "@/components/recipe-screen-header";

const RECIPE_FEED_ENTRY_BATCH_SIZE = 8;
const RECIPE_FEED_ENTRY_STAGGER_MS = 65;

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
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onNearEndRef = useRef(onNearEnd);
  useEffect(() => {
    onNearEndRef.current = onNearEnd;
  }, [onNearEnd]);
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const indexes = viewableItems
        .map((item) => item.index)
        .filter((index): index is number => index !== null);
      if (indexes.length > 0) onNearEndRef.current(Math.max(...indexes));
    },
  ).current;
  const renderItem = useCallback(
    ({ item, index }: { item: RecipeSuggestion; index: number }) => (
      <RecipeFeedCard
        recipe={item}
        entryIndex={index % RECIPE_FEED_ENTRY_BATCH_SIZE}
        onDismiss={(recipeId) => {
          onDismiss(recipeId);
          onNearEnd(index);
        }}
      />
    ),
    [onDismiss, onNearEnd],
  );

  // The skeleton card is reserved for the dismissal-burst edge: every card
  // was consumed while a refill run is still in flight. Ordinary scrolling
  // near the end shows no buffering UI because prefetch stays ahead of it.
  const showSkeleton = isPrefetching && recipes.length === 0;
  const footer = showSkeleton ? (
    <RecipeSkeletonCard />
  ) : prefetchError ? (
    <RecipeFeedMoreError
      hasRecipes={recipes.length > 0}
      onRetry={onRetryMore}
    />
  ) : isExhausted && recipes.length > 0 ? (
    <RecipeFeedTerminator
      hasRecipes
      onAddItems={onAddItems}
      onEditAnswers={onEditAnswers}
    />
  ) : (
    <View style={styles.footerSpace} />
  );

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
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={viewabilityConfig}
      initialNumToRender={RECIPE_FEED_ENTRY_BATCH_SIZE}
      maxToRenderPerBatch={RECIPE_FEED_ENTRY_BATCH_SIZE}
      updateCellsBatchingPeriod={16}
      windowSize={9}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.bg }}
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
  onDismiss,
}: {
  recipe: RecipeSuggestion;
  entryIndex: number;
  onDismiss: (recipeId: string) => void;
}) {
  const { colors, fonts } = useTheme();
  const [isDismissing, setIsDismissing] = useState(false);
  const entryOpacity = useRef(new Animated.Value(0)).current;
  const entryTranslateY = useRef(new Animated.Value(16)).current;
  const entryScale = useRef(new Animated.Value(0.985)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  // Capture the mount-time stagger delay once: dismissing a card above
  // shifts entryIndex, and a recomputed delay would replay the entry
  // animation on cards that have already settled.
  const entryDelay = useRef(
    Math.min(entryIndex, RECIPE_FEED_ENTRY_BATCH_SIZE - 1) *
      RECIPE_FEED_ENTRY_STAGGER_MS,
  ).current;

  useEffect(() => {
    entryOpacity.setValue(0);
    entryTranslateY.setValue(16);
    entryScale.setValue(0.985);
    const animation = Animated.parallel([
      Animated.timing(entryOpacity, {
        toValue: 1,
        duration: 280,
        delay: entryDelay,
        useNativeDriver: true,
      }),
      Animated.timing(entryTranslateY, {
        toValue: 0,
        duration: 360,
        delay: entryDelay,
        useNativeDriver: true,
      }),
      Animated.timing(entryScale, {
        toValue: 1,
        duration: 360,
        delay: entryDelay,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [entryDelay, entryOpacity, entryScale, entryTranslateY]);

  const dismiss = () => {
    if (isDismissing) return;
    setIsDismissing(true);
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
      if (finished) onDismiss(recipe.recipe_id);
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
        <Pressable
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
        </Pressable>
      </View>
      </Animated.View>
    </Animated.View>
  );
});

function RecipeSkeletonCard() {
  const { colors } = useTheme();

  return (
    <View
      testID="recipe-feed-skeleton"
      accessibilityLabel="Loading more recipes"
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.skeletonLabel, { backgroundColor: colors.surfaceAlt }]} />
      <View style={[styles.skeletonTitle, { backgroundColor: colors.surfaceAlt }]} />
      <View style={[styles.skeletonLine, { backgroundColor: colors.surfaceAlt }]} />
      <View style={[styles.skeletonLineShort, { backgroundColor: colors.surfaceAlt }]} />
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
      <Pressable
        onPress={onRetry}
        testID="recipe-feed-more-retry"
        accessibilityRole="button"
        style={[styles.retryButton, { borderColor: colors.border }]}
      >
        <Text style={[styles.retryText, { color: colors.text, fontFamily: fonts.bodyStrong }]}>
          Try again
        </Text>
      </Pressable>
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
          ? "You've explored all the recipes your kitchen could reasonably make."
          : "Your inventory can't support a coherent recipe yet. Try adding an item or changing the answers for this session."}
      </Text>
      <View style={styles.terminatorActions}>
        <Pressable
          onPress={onAddItems}
          testID="recipe-feed-add-items"
          accessibilityRole="button"
          style={[styles.primaryTerminatorButton, { backgroundColor: colors.accent }]}
        >
          <Text style={[styles.primaryTerminatorText, { color: colors.accentInk, fontFamily: fonts.bodyStrong }]}>
            Add items
          </Text>
        </Pressable>
        <Pressable
          onPress={onEditAnswers}
          testID="recipe-feed-edit-answers"
          accessibilityRole="button"
          style={[styles.secondaryTerminatorButton, { borderColor: colors.border }]}
        >
          <Text style={[styles.secondaryTerminatorText, { color: colors.text, fontFamily: fonts.bodyStrong }]}>
            Edit answers
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  separator: {
    height: 10,
  },
  footerSpace: {
    height: 24,
  },
  card: {
    marginHorizontal: 16,
    padding: 18,
    borderWidth: 1,
    borderRadius: 18,
    overflow: "hidden",
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 28,
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
  },
  dismissButton: {
    minHeight: 44,
    borderRadius: 11,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  dismissText: {
    fontSize: 12,
  },
  skeletonLabel: {
    width: 86,
    height: 24,
    borderRadius: 100,
  },
  skeletonTitle: {
    width: "78%",
    height: 26,
    borderRadius: 7,
    marginTop: 18,
  },
  skeletonLine: {
    width: "55%",
    height: 13,
    borderRadius: 5,
    marginTop: 14,
  },
  skeletonLineShort: {
    width: "35%",
    height: 13,
    borderRadius: 5,
    marginTop: 8,
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
    padding: 20,
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
