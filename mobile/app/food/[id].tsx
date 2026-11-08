import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import LoadingState from "@/components/LoadingState";
import ErrorState from "@/components/ErrorState";
import BatchCard from "@/components/BatchCard";
import LotOutcomeSwipe from "@/components/LotOutcomeSwipe";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { inDrawOrder, stackLots } from "@/lib/foodRows";

/**
 * Shows one food and its live batches in draw order, tagging the batch to use
 * first. Tapping a batch opens the batch editor. Swiping a batch records it as
 * used up or tossed. The screen closes when the food's last batch goes away
 * while it is open, whether by a swipe, a delete or another phone. The route
 * param is the food id.
 */
export default function FoodDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, fonts } = useTheme();
  const inventory = useInventoryItems();

  const lotsOfFood = useMemo(
    () => (inventory.data ?? []).filter((lot) => lot.food_id === id),
    [inventory.data, id],
  );
  const row = useMemo(() => stackLots(lotsOfFood)[0] ?? null, [lotsOfFood]);
  const batches = useMemo(() => inDrawOrder(lotsOfFood), [lotsOfFood]);

  const emptied = useLeaveWhenEmptied(row !== null);

  if (inventory.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Stack.Screen options={{ title: "" }} />
        <LoadingState />
      </View>
    );
  }

  if (inventory.isError && !inventory.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Stack.Screen options={{ title: "" }} />
        <ErrorState onRetry={() => inventory.refetch()} />
      </View>
    );
  }

  if (emptied) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  if (!row) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Stack.Screen options={{ title: "" }} />
        <ErrorState
          title="Item not found"
          message="This item may have been removed."
          onRetry={() => router.back()}
        />
      </View>
    );
  }

  const iconName = (row.category?.icon ?? "circle-o") as React.ComponentProps<
    typeof FontAwesome
  >["name"];
  const subline = [row.category?.name ?? "Uncategorized", `${formatQuantity(row.total)} ${row.unit}`];
  if (row.lots.length > 1) subline.push(`${row.lots.length} batches`);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: "",
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerTintColor: colors.text,
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 4 }}>
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 16,
              backgroundColor: colors.accentSoft,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <FontAwesome name={iconName} size={32} color={colors.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{
                fontFamily: fonts.display,
                fontSize: 24,
                letterSpacing: -0.5,
                color: colors.text,
              }}
              numberOfLines={2}
            >
              {row.name}
            </Text>
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: 13,
                color: colors.textMuted,
                marginTop: 2,
              }}
            >
              {subline.join(" · ")}
            </Text>
          </View>
        </View>

        <Text
          style={{
            fontFamily: fonts.bodyStrong,
            fontSize: 11,
            color: colors.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginTop: 8,
            marginBottom: -4,
          }}
        >
          Batches
        </Text>
        {batches.map((batch) => (
          <LotOutcomeSwipe key={batch.lot.id} lotIds={[batch.lot.id]} name={row.name}>
            <BatchCard batch={batch} onPress={() => router.push(`/item/${batch.lot.id}`)} />
          </LotOutcomeSwipe>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Goes back once a screen that had content this visit loses it, and returns
 * true from then on so the screen can render blank while it leaves. Waits
 * while another screen is on top, such as the batch editor whose delete
 * emptied this one, and leaves when this screen is shown again.
 *
 * @param hasContent - Whether the screen has anything to show right now.
 */
function useLeaveWhenEmptied(hasContent: boolean): boolean {
  const router = useRouter();
  const isFocused = useIsFocused();
  const [hadContent, setHadContent] = useState(false);
  if (hasContent && !hadContent) setHadContent(true);
  const emptied = hadContent && !hasContent;

  useEffect(() => {
    if (emptied && isFocused) router.back();
  }, [emptied, isFocused, router]);

  return emptied;
}

function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(1);
}
