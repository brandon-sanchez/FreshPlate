import { memo, useEffect, useRef, useState } from "react";
import {
  Animated as NativeAnimated,
  PixelRatio,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Feather from "@expo/vector-icons/Feather";
import Ionicons from "@expo/vector-icons/Ionicons";
import RecipePhoto from "@/components/recipe-photo";
import RecipeSaveButton from "@/components/recipe-save-button";
import RecipeStats, { recipeStatsLabel } from "@/components/recipe-stats";
import { RecipeActivity, RecipePressable } from "@/components/recipe-motion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";

type RecipeCardProps = {
  /** The recipe the card shows. */
  recipe: RecipeSuggestion;
  /** Lets the photo request run; a first request may start a paid generation. */
  photoEnabled: boolean;
  /** Height of the card's row in the list, in points, including the gap. */
  stride: number;
  /** Card height in points; the feed picks it from the screen and text size. */
  cardHeight: number;
  /** Card width in points: the screen width less the feed's side padding. */
  cardWidth: number;
  /** Skips the entry animation. */
  reducedMotion: boolean;
  /** Stacks the feedback buttons for large text sizes. */
  largeText: boolean;
  /** Uses the shorter photo and tighter spacing of the carousel card. */
  compact: boolean;
  /** Starts the entry animation the first time it turns true. */
  revealed: boolean;
  /** Ids whose entry already played, shared across the feed's cards. */
  animatedIds: Set<string>;
  /** Called by "Less like this". */
  onLessLikeThis: (recipe: RecipeSuggestion) => void;
  /** Opens the preview sheet; called when the card is tapped. */
  onPreview: (recipe: RecipeSuggestion) => void;
  /** Called by "More like this". */
  onMoreLikeThis: (recipe: RecipeSuggestion) => void;
  /** Starts a cook; called when a right swipe passes the cook threshold. */
  onCook: (recipe: RecipeSuggestion) => void;
  /** Whether the recipe is in the household cookbook. */
  saved: boolean;
  /** Called by the bookmark with the recipe's current saved state. */
  onToggleSave: (recipe: RecipeSuggestion, saved: boolean) => void;
  /** Blocks the bookmark while a save or unsave is in flight. */
  isSavePending: boolean;
};

/**
 * Renders one recipe in the feed: photo with the save toggle, title, Time and
 * Serves, the ingredient teaser, and the "Less like this" and "More like this"
 * buttons. Tapping anywhere else on the card opens the preview, and a right
 * swipe starts a cook. The feed plays the card's exit when a button sweeps it
 * away.
 */
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
  onLessLikeThis,
  onPreview,
  onMoreLikeThis,
  onCook,
  saved,
  onToggleSave,
  isSavePending,
}: RecipeCardProps) {
  const { colors, fonts } = useTheme();
  const startsAtRest = useRef(
    reducedMotion || animatedIds.has(recipe.recipe_id),
  ).current;
  const entryOpacity = useRef(
    new NativeAnimated.Value(startsAtRest ? 1 : 0.45),
  ).current;
  const entryY = useRef(
    new NativeAnimated.Value(startsAtRest ? 0 : 24),
  ).current;
  const swipeX = useRef(new NativeAnimated.Value(0)).current;
  const onCookRef = useRef(onCook);
  onCookRef.current = onCook;
  // Swipe right skips the preview sheet and starts cooking. Vertical drags
  // stay with the feed's scroll.
  const cookSwipe = useRef(
    Gesture.Pan()
      .withTestId(`recipe-card-cook-swipe-${recipe.recipe_id}`)
      .runOnJS(true)
      .activeOffsetX(24)
      .failOffsetY([-16, 16])
      .onUpdate(({ translationX }) => swipeX.setValue(Math.max(0, translationX)))
      .onEnd(({ translationX }) => {
        if (translationX > COOK_SWIPE_THRESHOLD) onCookRef.current(recipe);
      })
      .onFinalize(() => {
        NativeAnimated.spring(swipeX, {
          toValue: 0,
          stiffness: 260,
          damping: 28,
          useNativeDriver: true,
        }).start();
      }),
  ).current;
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
  return (
    <View style={{ height: stride, paddingHorizontal: 24 }}>
      <GestureDetector gesture={cookSwipe}>
        <View>
          <NativeAnimated.View
            pointerEvents="none"
            style={[
              styles.cookReveal,
              {
                height: cardHeight,
                backgroundColor: colors.accent,
                opacity: swipeX.interpolate({
                  inputRange: [0, COOK_SWIPE_THRESHOLD],
                  outputRange: [0, 1],
                  extrapolate: "clamp",
                }),
              },
            ]}
          >
            <Ionicons name="flame" size={23} color={colors.accentInk} />
            <Text
              style={{
                color: colors.accentInk,
                fontFamily: fonts.bodyStrong,
                fontSize: 15,
              }}
            >
              Cook this
            </Text>
          </NativeAnimated.View>
          <NativeAnimated.View
            testID={"recipe-card-" + recipe.recipe_id}
            style={{
              opacity: entryOpacity,
              transform: [{ translateY: entryY }, { translateX: swipeX }],
            }}
          >
            {/* Pressable is an accessibility element by default, which would
                merge the save and feedback buttons into one target. The
                summary view below is the card's screen reader element. */}
            <RecipePressable
              accessible={false}
              onPress={() => onPreview(recipe)}
              unstable_pressDelay={CARD_PRESS_DELAY_MS}
              testID={"recipe-card-open-" + recipe.recipe_id}
              style={[
                styles.card,
                {
                  width: cardWidth,
                  height: cardHeight,
                  backgroundColor: colors.surface,
                },
              ]}
            >
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel={cardSummaryLabel(recipe)}
                accessibilityHint="Opens the recipe preview"
                onAccessibilityTap={() => onPreview(recipe)}
                accessibilityActions={ANDROID_ACTIVATE}
                onAccessibilityAction={() => onPreview(recipe)}
                testID={"recipe-card-preview-" + recipe.recipe_id}
                style={styles.summary}
              >
                <View
                  style={[
                    styles.artwork,
                    compact && styles.compactArtwork,
                    { backgroundColor: colors.accentSoft },
                  ]}
                >
                  <RecipePhoto
                    recipeId={recipe.recipe_id}
                    title={recipe.title}
                    variant="card"
                    enabled={photoEnabled}
                    style={StyleSheet.absoluteFill}
                  />
                </View>
                <View
                  style={[
                    styles.summaryText,
                    compact && styles.compactSummaryText,
                  ]}
                >
                  <Text
                    numberOfLines={compact ? 2 : 3}
                    style={[
                      compact ? styles.compactTitle : styles.title,
                      { fontFamily: fonts.display, color: colors.text },
                    ]}
                  >
                    {recipe.title}
                  </Text>
                  <RecipeStats recipe={recipe} dense grouped />
                  <RecipeCardTeaser recipe={recipe} />
                </View>
              </View>
              {/* A disabled Pressable doesn't claim the touch, which would
                  then reach the card and open the preview. These wrappers
                  keep every touch on the buttons' own area. */}
              <View
                onStartShouldSetResponder={claimTouch}
                style={styles.saveButton}
              >
                <RecipeSaveButton
                  variant="pill"
                  saved={saved}
                  title={recipe.title}
                  disabled={isSavePending}
                  onPress={() => onToggleSave(recipe, saved)}
                  testID={"recipe-card-save-" + recipe.recipe_id}
                />
              </View>
              <View
                onStartShouldSetResponder={claimTouch}
                style={[
                  styles.feedback,
                  compact && styles.compactFeedback,
                  largeText && styles.feedbackStacked,
                ]}
              >
                <RecipeFeedbackButton
                  tone="less"
                  onPress={() => onLessLikeThis(recipe)}
                  title={recipe.title}
                  testID={"recipe-card-less-like-this-" + recipe.recipe_id}
                />
                <RecipeFeedbackButton
                  tone="more"
                  onPress={() => onMoreLikeThis(recipe)}
                  title={recipe.title}
                  testID={"recipe-card-more-like-this-" + recipe.recipe_id}
                />
              </View>
            </RecipePressable>
          </NativeAnimated.View>
        </View>
      </GestureDetector>
    </View>
  );
});

const claimTouch = () => true;

// Horizontal travel, in points, that a released right swipe must pass to start a cook.
const COOK_SWIPE_THRESHOLD = 96;

// Holds off the card's press-in shrink long enough for a swipe to start, so
// the card doesn't shrink at the beginning of every scroll.
const CARD_PRESS_DELAY_MS = 90;

// iOS reaches the summary through `onAccessibilityTap`; Android needs the
// standard activate action. On iOS that action would also show up as an
// extra "activate" entry in the VoiceOver actions rotor.
const ANDROID_ACTIVATE =
  Platform.OS === "android" ? [{ name: "activate" as const }] : undefined;

/** Builds what a screen reader says for the card's summary. */
function cardSummaryLabel(recipe: RecipeSuggestion) {
  const parts = [recipe.title, recipeStatsLabel(recipe)];
  if (recipe.saves_expiring.length > 0) {
    parts.push(`Uses up ${recipe.saves_expiring.join(", ")}`);
  }
  return parts.join(". ");
}

const TEASER_LINE_HEIGHT = 21;
const USES_UP_LINE_HEIGHT = 16;
const TEASER_GAP = 4;
const MAX_INGREDIENT_LINES = 3;

/**
 * Fills the card's leftover height with whole lines: the "Uses up" line
 * first, because it names food that is about to expire, then up to three lines
 * of ingredient names. A line that doesn't fit is left out instead of being
 * cut in half. The preview sheet always lists every ingredient.
 */
function RecipeCardTeaser({ recipe }: { recipe: RecipeSuggestion }) {
  const { colors, fonts } = useTheme();
  const [height, setHeight] = useState(0);
  const scale = PixelRatio.getFontScale();
  const usesUpHeight = USES_UP_LINE_HEIGHT * scale;
  const showUsesUp = recipe.saves_expiring.length > 0 && height >= usesUpHeight;
  const ingredientLines = Math.min(
    MAX_INGREDIENT_LINES,
    Math.floor(
      (height - (showUsesUp ? usesUpHeight + TEASER_GAP : 0)) /
        (TEASER_LINE_HEIGHT * scale),
    ),
  );
  return (
    <View
      testID={"recipe-card-teaser-" + recipe.recipe_id}
      style={styles.teaser}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      {ingredientLines > 0 && (
        <Text
          numberOfLines={ingredientLines}
          style={{
            color: colors.text,
            fontFamily: fonts.body,
            fontSize: 14,
            lineHeight: TEASER_LINE_HEIGHT,
          }}
        >
          <Text
            style={{ color: colors.textMuted, fontFamily: fonts.bodyStrong }}
          >
            Ingredients{"  "}
          </Text>
          {recipe.ingredients.map((ingredient) => ingredient.name).join(" · ")}
        </Text>
      )}
      {showUsesUp && (
        <Text
          numberOfLines={1}
          style={{
            color: colors.warn,
            fontFamily: fonts.body,
            fontSize: 12,
            lineHeight: USES_UP_LINE_HEIGHT,
          }}
        >
          Uses up {recipe.saves_expiring.join(", ")}
        </Text>
      )}
    </View>
  );
}

// `FEEDBACK_TINT_ALPHA` keeps the `crit` and `accent` labels at 4.5:1
// contrast or better (WCAG AA) on the tint in both color schemes.
const FEEDBACK_TINT_ALPHA = "14";
const FEEDBACK_BORDER_ALPHA = "59";

function RecipeFeedbackButton({
  tone,
  onPress,
  title,
  testID,
}: {
  tone: "less" | "more";
  onPress: () => void;
  title: string;
  testID: string;
}) {
  const { colors, fonts } = useTheme();
  const ink = tone === "less" ? colors.crit : colors.accent;
  const label = tone === "less" ? "Less like this" : "More like this";
  return (
    <RecipePressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${title}`}
      testID={testID}
      style={[
        styles.feedbackButton,
        {
          backgroundColor: ink + FEEDBACK_TINT_ALPHA,
          borderColor: ink + FEEDBACK_BORDER_ALPHA,
        },
      ]}
    >
      <Feather
        name={tone === "less" ? "thumbs-down" : "thumbs-up"}
        size={15}
        color={ink}
      />
      <Text style={{ color: ink, fontFamily: fonts.bodyStrong, fontSize: 14 }}>
        {label}
      </Text>
    </RecipePressable>
  );
}

/**
 * Renders the card-shaped placeholder that holds the feed's tail while more
 * recipes load, with the same photo height and padding as a recipe card. Its
 * lines pulse unless Reduce Motion is on.
 */
export function RecipeSkeletonCard({
  cardHeight,
  reducedMotion,
  compact,
}: {
  /** Matches the recipe cards' height, in points. */
  cardHeight: number;
  /** Holds the lines at a fixed opacity instead of pulsing. */
  reducedMotion: boolean;
  /** Uses the carousel card's shorter photo and tighter padding. */
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
            compact && styles.compactArtwork,
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
            styles.skeletonContent,
            compact && styles.compactSkeletonContent,
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
  cookReveal: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 24,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 28,
  },
  card: {
    borderRadius: 24,
    borderCurve: "continuous",
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(27,31,28,0.07)",
  },
  summary: { flex: 1 },
  artwork: { height: 164 },
  compactArtwork: { height: 136 },
  summaryText: { flex: 1, paddingHorizontal: 18, paddingTop: 16, gap: 12 },
  compactSummaryText: { paddingHorizontal: 16, paddingTop: 14, gap: 10 },
  title: { fontSize: 24, lineHeight: 28, letterSpacing: -0.5 },
  compactTitle: { fontSize: 22, lineHeight: 26, letterSpacing: -0.4 },
  teaser: { flex: 1, gap: TEASER_GAP, overflow: "hidden" },
  skeletonContent: { flex: 1, padding: 18, gap: 12 },
  compactSkeletonContent: { padding: 16, gap: 10 },
  feedback: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 18,
  },
  compactFeedback: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16 },
  feedbackStacked: { flexDirection: "column" },
  feedbackButton: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  saveButton: { position: "absolute", right: 14, top: 14, zIndex: 2 },
});
