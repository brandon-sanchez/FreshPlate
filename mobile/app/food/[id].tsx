import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import LoadingState from "@/components/LoadingState";
import ErrorState from "@/components/ErrorState";
import BatchCard from "@/components/BatchCard";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { inDrawOrder, stackLots } from "@/lib/foodRows";

/**
 * Shows one food and its live batches in draw order, tagging the batch to use
 * first. Tapping a batch opens the batch editor. The route param is the food
 * id.
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
          <BatchCard
            key={batch.lot.id}
            batch={batch}
            onPress={() => router.push(`/item/${batch.lot.id}`)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(1);
}
