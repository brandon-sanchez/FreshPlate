import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Toast from "react-native-toast-message";
import { useTheme } from "@/hooks/useTheme";
import LoadingState from "@/components/LoadingState";
import ErrorState from "@/components/ErrorState";
import BatchCard from "@/components/BatchCard";
import SectionLabel from "@/components/SectionLabel";
import LotOutcomeSwipe from "@/components/LotOutcomeSwipe";
import { type InventoryItem, useInventoryItems } from "@/hooks/useInventoryItems";
import { useCombineLots } from "@/hooks/useCombineLots";
import { inDrawOrder, stackLots } from "@/lib/foodRows";
import { formatAmount } from "@/lib/amount";

/**
 * Shows one food and its live batches in draw order, tagging the batch to use
 * first. Tapping a batch opens the batch editor. Swiping a batch records it as
 * used up or tossed. Combine picks batches that were physically mixed and
 * pours them into the picked batch that cooking draws first. The screen
 * closes when the food's last batch goes away
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
  const combineLots = useCombineLots();
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  // In draw order, and only live batches, so a batch another phone used up
  // drops out. The first one, usually the opened container, holds the mix.
  const pickedLotIds = batches.map((b) => b.lot.id).filter((lotId) => selection?.has(lotId));

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

  const combine = () => {
    const [intoLotId, ...pouredLotIds] = pickedLotIds;
    if (pouredLotIds.length === 0 || combineLots.isPending) return;
    combineLots.mutate(
      { name: row.name, intoLotId, lotIds: pouredLotIds },
      {
        onSuccess: () => {
          setSelection(null);
          Toast.show({
            type: "success",
            text1: `Combined ${pickedLotIds.length} batches of ${row.name}`,
            text2: "They're one opened batch with the earliest date.",
          });
        },
      },
    );
  };

  const iconName = (row.category?.icon ?? "circle-o") as React.ComponentProps<
    typeof FontAwesome
  >["name"];
  const subline = [row.category?.name ?? "Uncategorized", formatAmount(row.total, row.unit, row.isEstimate)];
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
      <ScrollView contentContainerStyle={{
          padding: 16,
          paddingBottom: selection === null ? 40 : 150,
          gap: 16,
        }}>
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

        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: -4 }}>
          <View style={{ flex: 1 }}>
            <SectionLabel text="Batches" inline />
          </View>
          {batches.length > 1 && selection === null ? (
            <Pressable
              onPress={() => setSelection(new Set())}
              accessibilityRole="button"
              accessibilityLabel="Combine"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 100,
                backgroundColor: colors.surfaceAlt,
              }}
            >
              <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 12.5, color: colors.textMuted }}>
                Combine
              </Text>
            </Pressable>
          ) : null}
        </View>
        {selection !== null ? (
          <Text style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted }}>
            Pick the batches you mixed into one container. The mix counts as opened and takes the
            earliest date.
          </Text>
        ) : null}
        {batches.map((batch) =>
          selection !== null ? (
            <BatchCard
              key={batch.lot.id}
              batch={batch}
              selected={selection.has(batch.lot.id)}
              onPress={() => setSelection(toggled(selection, batch.lot.id))}
            />
          ) : (
            <LotOutcomeSwipe key={batch.lot.id} lotIds={[batch.lot.id]} name={row.name}>
              <BatchCard batch={batch} onPress={() => router.push(`/item/${batch.lot.id}`)} />
            </LotOutcomeSwipe>
          ),
        )}
      </ScrollView>
      {selection !== null ? (
        <CombineBar
          count={pickedLotIds.length}
          into={batches.find((b) => b.lot.id === pickedLotIds[0])?.lot ?? null}
          busy={combineLots.isPending}
          onCancel={() => setSelection(null)}
          onCombine={combine}
        />
      ) : null}
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

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Names the batch that holds the mix the way someone finds it on the shelf:
 * its amount and the day it was opened, or added if it is still sealed.
 */
function intoText(lot: InventoryItem): string {
  const day = new Date(lot.opened_at ?? lot.created_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const amount = formatAmount(lot.quantity, lot.unit, lot.is_estimate);
  return `Into the ${amount} ${lot.opened_at === null ? "added" : "opened"} ${day}`;
}

/**
 * Renders the bottom bar that says where the picked batches go and confirms
 * or cancels combining them. `into` is the batch that holds the mix, or
 * `null` while nothing is picked.
 */
function CombineBar({
  count,
  into,
  busy,
  onCancel,
  onCombine,
}: {
  count: number;
  into: InventoryItem | null;
  busy: boolean;
  onCancel: () => void;
  onCombine: () => void;
}) {
  const { colors, fonts } = useTheme();
  const disabled = count < 2 || busy;
  const label = `Combine ${count} batch${count === 1 ? "" : "es"}`;
  return (
    <View
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        gap: 10,
        padding: 16,
        paddingBottom: 28,
        backgroundColor: colors.bg,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, textAlign: "center" }}
      >
        {into === null ? "Pick 2 or more batches" : intoText(into)}
      </Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={{
            flex: 1,
            height: 50,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 14.5, color: colors.text }}>
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={onCombine}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={{
            flex: 1,
            height: 50,
            borderRadius: 12,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 14.5, color: colors.accentInk }}>
            {busy ? "Combining…" : label}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
