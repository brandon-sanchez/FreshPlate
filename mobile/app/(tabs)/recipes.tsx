import { useCallback, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/hooks/useTheme";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { useRecipeFeed } from "@/hooks/useRecipeFeed";
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
import {
  RecipeContextBar,
  RecipeScreenHeader,
} from "@/components/recipe-screen-header";

export default function RecipesScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const inventory = useInventoryItems();
  const feed = useRecipeFeed();
  const [preferences, setPreferences] = useState<RecipePreferences>({});
  const [flowOpen, setFlowOpen] = useState(false);

  const items = inventory.data ?? [];

  const generate = useCallback(
    (nextPreferences: RecipePreferences) => {
      setPreferences(nextPreferences);
      setFlowOpen(false);
      feed.start(buildRecipeFeedSessionRequest(items, nextPreferences));
    },
    [feed, items],
  );

  if (inventory.isPending) {
    return (
      <View
        style={[styles.stateContainer, { backgroundColor: colors.bg, paddingTop: insets.top }]}
      >
        <LoadingState label="Loading your fridge..." />
      </View>
    );
  }

  if (inventory.isError) {
    return (
      <View
        style={[styles.stateContainer, { backgroundColor: colors.bg, paddingTop: insets.top }]}
      >
        <ErrorState onRetry={() => inventory.refetch()} />
      </View>
    );
  }

  if (flowOpen) {
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
        <RecipeScreenHeader subtitle="Shape this session's suggestions" />
        <RecipePreferenceFlow
          initialPreferences={preferences}
          onComplete={generate}
          onCancel={() => setFlowOpen(false)}
        />
      </View>
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
        style={[styles.stateContainer, { backgroundColor: colors.bg, paddingTop: insets.top }]}
      >
        <RecipeScreenHeader subtitle={recipeContextLabel(items.length, preferences)} />
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
      />
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 12,
        paddingBottom: tabBarHeight + 28,
      }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <RecipeScreenHeader subtitle="AI picks from your kitchen" />

      <RecipeContextBar
        itemCount={items.length}
        preferences={preferences}
        onAsk={() => setFlowOpen(true)}
      />

      <View
        style={[
          styles.promptCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <View style={[styles.promptIcon, { backgroundColor: colors.accentSoft }]}>
          <FontAwesome name="magic" size={24} color={colors.accent} />
        </View>
        <Text style={[styles.promptTitle, { color: colors.text, fontFamily: fonts.display }]}>
          What sounds good?
        </Text>
        <Text style={[styles.promptText, { color: colors.textMuted, fontFamily: fonts.body }]}>
          Answer a few quick questions or generate from your inventory alone.
        </Text>
      </View>

      <View style={styles.buttonStack}>
        <Pressable
          onPress={() => generate(preferences)}
          accessibilityRole="button"
          style={[styles.primaryAction, { backgroundColor: colors.accent }]}
        >
          <FontAwesome name="magic" size={15} color={colors.accentInk} />
          <Text style={[styles.primaryActionText, { color: colors.accentInk, fontFamily: fonts.bodyStrong }]}>
            Generate from my fridge
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setFlowOpen(true)}
          accessibilityRole="button"
          style={[styles.secondaryAction, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          <FontAwesome name="list" size={14} color={colors.textMuted} />
          <Text style={[styles.secondaryActionText, { color: colors.text, fontFamily: fonts.bodyStrong }]}>
            {countAnsweredPreferences(preferences) > 0
              ? "Edit session answers"
              : "Ask me questions first"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  stateContainer: {
    flex: 1,
  },
  promptCard: {
    marginHorizontal: 16,
    marginTop: 16,
    padding: 24,
    borderWidth: 1,
    borderRadius: 18,
    alignItems: "center",
  },
  promptIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  promptTitle: {
    fontSize: 19,
    letterSpacing: -0.3,
  },
  promptText: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 7,
    maxWidth: 290,
  },
  buttonStack: {
    marginHorizontal: 16,
    marginTop: 18,
    gap: 10,
  },
  primaryAction: {
    minHeight: 52,
    borderRadius: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryActionText: {
    fontSize: 14,
  },
  secondaryAction: {
    minHeight: 50,
    borderWidth: 1,
    borderRadius: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  secondaryActionText: {
    fontSize: 14,
  },
});
