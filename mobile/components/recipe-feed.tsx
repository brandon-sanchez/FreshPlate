import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  View,
  useWindowDimensions,
  type ViewToken,
} from "react-native";
import type { ReactNode } from "react";
import Animated, { Easing, LinearTransition } from "react-native-reanimated";
import RecipeCard, { RecipeSkeletonCard } from "@/components/recipe-card";
import RecipeCarousel from "@/components/recipe-carousel";
import RecipeFeedMessage from "@/components/recipe-feed-message";
import RecipeIngredientsSheet from "@/components/recipe-ingredients-sheet";
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
  /** Called by a card's "More like this" button with that card's recipe. */
  onMoreLikeThis: (recipe: RecipeSuggestion) => void;
  onNearEnd: (lastVisibleIndex: number) => void;
  onRetryMore: () => void;
  onAddItems: () => void;
  onEditAnswers: () => void;
  savedIds?: Set<string>;
  onToggleSave?: (recipe: RecipeSuggestion, saved: boolean) => void;
  isSavePending?: boolean;
  header?: ReactNode;
  onOpenDetail?: (recipe: RecipeSuggestion) => void;
  /** Starts a cook of the recipe from a right swipe on its card or from the preview sheet. */
  onCook: (recipe: RecipeSuggestion) => void;
};

// Viewport points the stacked carousel keeps beside its card: the 44 pt
// pager, plus 40 pt split above and below the centered card so the next
// card's 20 pt peek still shows.
const STACK_CHROME_HEIGHT = 84;

// Smallest compact card, in points, that fits the photo, a two-line title,
// the Time and Serves block, one ingredient line with "Uses up", and the
// feedback row without clipping.
const COMPACT_CARD_MIN_HEIGHT = 408;

const replacementTransition = LinearTransition.duration(360).easing(
  Easing.inOut(Easing.cubic),
);

/**
 * The vertical feed of generated recipe cards with prefetch, dismiss, save and
 * cook actions. A right swipe on a card starts a cook through `onCook`.
 */
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
  onMoreLikeThis,
  onNearEnd,
  onRetryMore,
  onAddItems,
  onEditAnswers,
  savedIds = new Set<string>(),
  onToggleSave = () => undefined,
  isSavePending = false,
  header,
  onOpenDetail,
  onCook,
}: RecipeFeedProps) {
  const { colors } = useTheme();
  const { width, height, fontScale } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const largeTextExtra = Math.max(0, fontScale - 1) * 240;
  const fullCardHeight = Math.round(
    Math.min(530, Math.max(480, height * 0.53)) + largeTextExtra,
  );
  const [listHeight, setListHeight] = useState(0);
  // Headers above the feed, such as the Cooking banner, shorten the viewport,
  // so the stacked card shrinks to the space left, down to the height its
  // content needs.
  const stackCardHeight = Math.round(
    Math.min(
      Math.min(440, Math.max(420, height * 0.45)) + largeTextExtra,
      listHeight - STACK_CHROME_HEIGHT,
    ),
  );
  const stackEnabled =
    fontScale <= 1.2 &&
    stackCardHeight >= COMPACT_CARD_MIN_HEIGHT + largeTextExtra;
  const cardHeight = stackEnabled ? stackCardHeight : fullCardHeight;
  const stride = cardHeight + 20;
  const listRef = useRef<FlatList<RecipeSuggestion>>(null);
  const [revealedIds, setRevealedIds] = useState(new Set<string>());
  const [previewRecipe, setPreviewRecipe] = useState<RecipeSuggestion | null>(
    null,
  );
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
      // The carousel mounts four cards on each side of the active one, so
      // only the active card and the next count as seen. A seen card may
      // start a paid photo generation.
      setRevealedIds((previous) => {
        const next = new Set(previous);
        for (const recipe of recipesRef.current.slice(index, index + 2)) {
          next.add(recipe.recipe_id);
        }
        return next.size === previous.size ? previous : next;
      });
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
        photoEnabled={revealedIds.has(item.recipe_id)}
        stride={stride}
        cardHeight={cardHeight}
        cardWidth={width - 48}
        reducedMotion={reducedMotion}
        largeText={fontScale > 1.2}
        compact={stackEnabled}
        revealed={stackEnabled || revealedIds.has(item.recipe_id)}
        animatedIds={animatedIds}
        onDismiss={dismissRecipe}
        onPreview={setPreviewRecipe}
        onMoreLikeThis={onMoreLikeThis}
        onCook={onCook}
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
      onMoreLikeThis,
      onToggleSave,
      savedIds,
      isSavePending,
      onCook,
    ],
  );
  const footer = isPrefetching ? (
    <RecipeSkeletonCard
      cardHeight={cardHeight}
      reducedMotion={reducedMotion}
      compact={stackEnabled}
    />
  ) : prefetchError ? (
    <RecipeFeedMessage
      icon="cloud-off"
      isError
      message={
        recipes.length
          ? "We couldn't load more recipes right now."
          : "We couldn't load recipes right now."
      }
      actions={[
        {
          label: "Try again",
          onPress: onRetryMore,
          variant: "primary",
          testID: "recipe-feed-more-retry",
        },
      ]}
      testID="recipe-feed-error"
    />
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
                kind: "recipe" as const,
                content: renderItem({ item: recipe, index }),
              })),
              ...(footer
                ? [
                    {
                      id: "recipe-feed-tail",
                      kind: isPrefetching
                        ? ("loading" as const)
                        : ("message" as const),
                      content: (
                        <View
                          style={{
                            height: cardHeight,
                            justifyContent: "center",
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
        recipe={previewRecipe}
        onClose={() => setPreviewRecipe(null)}
        onOpenDetail={onOpenDetail}
        onCook={onCook}
      />
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
  return (
    <RecipeFeedMessage
      icon={hasRecipes ? "check-circle" : "shopping-bag"}
      title={hasRecipes ? "That's all for now" : "A little more to work with"}
      message={
        hasRecipes
          ? "You've explored this set of recipe ideas. Add ingredients or edit your answers for a fresh set."
          : "Your inventory can't support a coherent recipe yet. Add an ingredient or change your answers."
      }
      actions={[
        {
          label: "Add items",
          onPress: onAddItems,
          variant: "primary",
          testID: "recipe-feed-add-items",
        },
        {
          label: "Edit answers",
          onPress: onEditAnswers,
          variant: "secondary",
          testID: "recipe-feed-edit-answers",
        },
      ]}
      testID="recipe-feed-end"
    />
  );
}
