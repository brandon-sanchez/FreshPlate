import { useCallback, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Feather from "@expo/vector-icons/Feather";
import Toast from "react-native-toast-message";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/hooks/useTheme";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { useRecipeFeed } from "@/hooks/useRecipeFeed";
import { useSavedRecipes } from "@/hooks/useSavedRecipes";
import {
  buildRecipeFeedSessionRequest,
  countAnsweredPreferences,
  recipeContextLabel,
} from "@/lib/recipes";
import type { RecipePreferences } from "@/types/recipes";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import LoadingState from "@/components/LoadingState";
import RecipeFeed from "@/components/recipe-feed";
import RecipeGenerationLoader from "@/components/recipe-generation-loader";
import RecipePreferenceFlow from "@/components/recipe-preference-flow";
import RecipeActionButton from "@/components/recipe-action-button";
import RecipeContextComposer from "@/components/recipe-context-composer";
import { RecipePressable } from "@/components/recipe-motion";
import { RecipeScreenHeader } from "@/components/recipe-screen-header";

export default function RecipesScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const inventory = useInventoryItems();
  const feed = useRecipeFeed();
  const saved = useSavedRecipes();
  const [tab, setTab] = useState<"for-you" | "saved">("for-you");
  const [preferences, setPreferences] = useState<RecipePreferences>({});
  const [flowOpen, setFlowOpen] = useState(false);
  const items = inventory.data ?? [];

  const generate = useCallback(
    (nextPreferences: RecipePreferences) => {
      Keyboard.dismiss();
      const normalizedPreferences = { ...nextPreferences };
      if (normalizedPreferences.occasion?.trim()) {
        normalizedPreferences.occasion = normalizedPreferences.occasion.trim();
      } else {
        delete normalizedPreferences.occasion;
      }
      setPreferences(normalizedPreferences);
      setFlowOpen(false);
      feed.start(buildRecipeFeedSessionRequest(items, normalizedPreferences));
    },
    [feed, items],
  );

  if (tab === "saved") {
    return <View style={[styles.stateContainer, { backgroundColor: colors.bg, paddingTop: insets.top, paddingBottom: tabBarHeight }]}>
      <RecipeScreenHeader subtitle="Your household cookbook" />
      <RecipeTabs tab={tab} onChange={setTab} />
      <SavedRecipesContent saved={saved} />
    </View>;
  }

  if (inventory.isPending) {
    return (
      <View
        style={[
          styles.stateContainer,
          { backgroundColor: colors.bg, paddingTop: insets.top },
        ]}
      >
        <RecipeScreenHeader subtitle="AI picks from your kitchen" />
        <RecipeTabs tab={tab} onChange={setTab} />
        <LoadingState label="Loading your fridge..." />
      </View>
    );
  }

  if (inventory.isError) {
    return (
      <View
        style={[
          styles.stateContainer,
          { backgroundColor: colors.bg, paddingTop: insets.top },
        ]}
      >
        <RecipeScreenHeader subtitle="AI picks from your kitchen" />
        <RecipeTabs tab={tab} onChange={setTab} />
        <ErrorState onRetry={() => inventory.refetch()} />
      </View>
    );
  }

  if (flowOpen) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[
          styles.stateContainer,
          {
            backgroundColor: colors.bg,
            paddingTop: insets.top,
            paddingBottom: tabBarHeight,
          },
        ]}
      >
        <RecipeScreenHeader subtitle="Find something that feels right" />
        <RecipeTabs tab={tab} onChange={setTab} />
        <RecipePreferenceFlow
          initialPreferences={preferences}
          onComplete={generate}
          onCancel={() => setFlowOpen(false)}
        />
      </KeyboardAvoidingView>
    );
  }

  if (feed.status === "loading" || feed.isBootstrapping) {
    return (
      <View
        style={[
          styles.stateContainer,
          {
            backgroundColor: colors.bg,
            paddingTop: insets.top,
            paddingBottom: tabBarHeight,
          },
        ]}
      >
        <RecipeScreenHeader subtitle="AI picks from your kitchen" />
        <RecipeTabs tab={tab} onChange={setTab} />
        <RecipeGenerationLoader />
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View
        style={[
          styles.stateContainer,
          { backgroundColor: colors.bg, paddingTop: insets.top },
        ]}
      >
        <RecipeScreenHeader subtitle="Start with what you have" />
        <RecipeTabs tab={tab} onChange={setTab} />
        <EmptyState
          icon={
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                backgroundColor: colors.accentSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FontAwesome name="cutlery" size={24} color={colors.accent} />
            </View>
          }
          title="Let's find something to cook"
          message="Add some items to your inventory first"
          ctaLabel="Go to inventory"
          onCtaPress={() => router.push("/(tabs)/inventory")}
        />
      </View>
    );
  }

  if (feed.status === "error") {
    return (
      <View
        style={[
          styles.stateContainer,
          { backgroundColor: colors.bg, paddingTop: insets.top },
        ]}
      >
        <RecipeScreenHeader
          subtitle={recipeContextLabel(items.length, preferences)}
        />
        <RecipeTabs tab={tab} onChange={setTab} />
        <ErrorState
          title="We couldn't generate recipes"
          message="The AI kitchen is unavailable right now. Your answers are still here to try again."
          onRetry={feed.retry}
        />
      </View>
    );
  }

  if (feed.status === "ready") {
    return (
      <RecipeFeed
        header={<><RecipeScreenHeader /><RecipeTabs tab={tab} onChange={setTab} /></>}
        recipes={feed.recipes}
        itemCount={items.length}
        preferences={preferences}
        isPrefetching={feed.isPrefetching}
        prefetchError={feed.prefetchError}
        isExhausted={feed.isExhausted}
        topInset={insets.top}
        bottomInset={tabBarHeight + 28}
        onAsk={() => setFlowOpen(true)}
        onDismiss={feed.dismiss}
        onNearEnd={feed.maybePrefetch}
        onRetryMore={feed.retryPrefetch}
        onAddItems={() => router.push("/(tabs)/inventory")}
        onEditAnswers={() => setFlowOpen(true)}
        savedIds={saved.savedIds}
        onToggleSave={(recipe, isSaved) => {
          void saved.toggle({ recipe, saved: isSaved }).catch(() => {
            Toast.show({ type: "error", text1: "Couldn't update saved recipes", text2: "Check your connection and try again." });
          });
        }}
        isSavePending={saved.isToggling}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: tabBarHeight + 28,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <RecipeScreenHeader subtitle="AI picks from your kitchen" />
        <RecipeTabs tab={tab} onChange={setTab} />

        <View style={[styles.promptCard, { borderColor: colors.border }]}>
          <View style={styles.kitchenLabel}>
            <Feather name="feather" size={15} color={colors.accent} />
            <Text
              style={[
                styles.kitchenLabelText,
                { color: colors.accent, fontFamily: fonts.bodyStrong },
              ]}
            >
              {items.length} {items.length === 1 ? "ingredient" : "ingredients"}{" "}
              to start with
            </Text>
          </View>
          <Text
            style={[
              styles.promptTitle,
              { color: colors.text, fontFamily: fonts.display },
            ]}
          >
            What sounds{"\n"}good today?
          </Text>
          <Text
            style={[
              styles.promptText,
              { color: colors.textMuted, fontFamily: fonts.body },
            ]}
          >
            Turn what you have into something you want to cook.
          </Text>
        </View>

        <View style={styles.buttonStack}>
          <Text
            style={[
              styles.composerLabel,
              { color: colors.textMuted, fontFamily: fonts.bodyStrong },
            ]}
          >
            Have something in mind?
          </Text>
          <RecipeContextComposer
            value={preferences.occasion ?? ""}
            onChangeText={(occasion) =>
              setPreferences((previous) => ({ ...previous, occasion }))
            }
            onSubmit={() => generate(preferences)}
            testID="recipe-session-context"
          />
          <RecipeActionButton
            label={
              preferences.occasion?.trim()
                ? "Generate my recipes"
                : "Generate from my fridge"
            }
            onPress={() => generate(preferences)}
            testID="recipe-generate"
            style={styles.primaryAction}
          />
          <RecipePressable
            onPress={() => setFlowOpen(true)}
            accessibilityRole="button"
            style={styles.secondaryAction}
          >
            <Feather name="sliders" size={15} color={colors.accent} />
            <Text
              style={[
                styles.secondaryActionText,
                { color: colors.text, fontFamily: fonts.bodyStrong },
              ]}
            >
              {countAnsweredPreferences(preferences) > 0
                ? "Edit session answers"
                : "Ask me questions first"}
            </Text>
            <Feather name="arrow-right" size={15} color={colors.accent} />
          </RecipePressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  stateContainer: {
    flex: 1,
  },
  promptCard: {
    marginHorizontal: 24,
    marginTop: 16,
    paddingTop: 24,
    paddingBottom: 32,
    borderTopWidth: 1,
  },
  kitchenLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 20,
  },
  kitchenLabelText: { fontSize: 12, lineHeight: 18 },
  promptTitle: {
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: -1.2,
  },
  promptText: {
    fontSize: 15,
    lineHeight: 23,
    marginTop: 14,
    maxWidth: 290,
  },
  buttonStack: {
    marginHorizontal: 24,
    marginTop: 4,
    gap: 12,
  },
  composerLabel: { fontSize: 13, lineHeight: 20, marginLeft: 2 },
  primaryAction: {
    marginTop: 8,
  },
  secondaryAction: {
    minHeight: 50,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  secondaryActionText: {
    fontSize: 14,
  },
  tabs: { flexDirection: "row", marginHorizontal: 24, padding: 4, borderRadius: 14, backgroundColor: "#E9E6DE", marginBottom: 18 },
  tab: { flex: 1, minHeight: 40, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  tabText: { fontSize: 13 },
});

function SavedRecipeRow({ recipe, onRemove, disabled }: { recipe: import("@/types/recipes").RecipeSuggestion; onRemove: () => void; disabled: boolean }) {
  const { colors, fonts } = useTheme();
  return <View style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 12, gap: 8, borderWidth: 1, borderColor: colors.border, flexDirection: "row" }}>
    <View style={{ width: 110, height: 110, borderRadius: 12, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }}><Feather name="image" size={28} color={colors.accent} style={{ opacity: 0.35 }} /></View>
    <View style={{ flex: 1, gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "center" }}><Text style={{ flex: 1, color: colors.text, fontFamily: fonts.display, fontSize: 20 }}>{recipe.title}</Text><RecipePressable onPress={onRemove} disabled={disabled} accessibilityRole="button" accessibilityLabel={`Remove ${recipe.title} from saved recipes`} style={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" }}><Feather name="bookmark" size={20} color={colors.accent} fill={colors.accent} /></RecipePressable></View>
    <Text style={{ color: colors.textMuted, fontFamily: fonts.body, fontSize: 13 }}>{recipe.cook_time_minutes} min · {recipe.servings} servings · {recipe.match_percent}% match</Text>
    <Text style={{ color: colors.accent, fontFamily: fonts.bodyStrong, fontSize: 12 }}>Household cookbook</Text>
    </View>
  </View>;
}

function RecipeTabs({ tab, onChange }: { tab: "for-you" | "saved"; onChange: (tab: "for-you" | "saved") => void }) {
  const { colors, fonts } = useTheme();
  return <View style={styles.tabs}>
    {(["for-you", "saved"] as const).map((value) => <RecipePressable key={value} onPress={() => onChange(value)} accessibilityRole="tab" accessibilityLabel={value === "for-you" ? "For you recipes" : "Saved recipes"} accessibilityState={{ selected: tab === value }} style={[styles.tab, tab === value && { backgroundColor: colors.surface }]}><Text style={[styles.tabText, { color: tab === value ? colors.accent : colors.textMuted, fontFamily: fonts.bodyStrong }]}>{value === "for-you" ? "For you" : "Saved"}</Text></RecipePressable>)}
  </View>;
}

function SavedRecipesContent({ saved }: { saved: ReturnType<typeof useSavedRecipes> }) {
  const { colors } = useTheme();
  if (saved.isPending) return <LoadingState label="Loading your cookbook..." />;
  if (saved.isError) return <ErrorState onRetry={() => saved.refetch()} />;
  if (!saved.data?.length) return <EmptyState icon={<View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }}><Feather name="bookmark" size={24} color={colors.accent} /></View>} title="Nothing saved yet" message="Tap the bookmark on any recipe to keep it in your household cookbook" />;
  return <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }} showsVerticalScrollIndicator={false}>{saved.data.map((entry) => <SavedRecipeRow key={entry.recipe_id} recipe={entry.recipe} disabled={saved.isToggling} onRemove={() => { void saved.toggle({ recipe: entry.recipe, saved: true }).catch(() => Toast.show({ type: "error", text1: "Couldn't update saved recipes", text2: "Check your connection and try again." })); }} />)}</ScrollView>;
}
