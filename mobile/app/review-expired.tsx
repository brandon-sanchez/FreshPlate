import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { useLotOutcome } from "@/hooks/useLotOutcome";
import { useLeaveWhenEmptied } from "@/hooks/useLeaveWhenEmptied";
import LoadingState from "@/components/LoadingState";
import ErrorState from "@/components/ErrorState";
import ExpiredLotCard from "@/components/ExpiredLotCard";
import EmptyState from "@/components/EmptyState";
import { expiredLots } from "@/lib/foodRows";

/**
 * Lists the household's expired batches, most overdue first, so they can be
 * cleared: Still good gives a batch a new date and returns it to stock, Toss
 * records one batch as waste, and Toss all, after a confirmation, records every
 * listed batch. Tosses offer undo in their toast. The screen goes back once
 * nothing expired is left.
 */
export default function ReviewExpiredScreen() {
  const { colors, fonts } = useTheme();
  const inventory = useInventoryItems();
  const { record } = useLotOutcome();
  const [tossingAll, setTossingAll] = useState(false);

  const expired = useMemo(() => expiredLots(inventory.data ?? []), [inventory.data]);
  const expiredIds = expired.map((e) => e.lot.id).join(",");
  const batchCount = `${expired.length} expired batch${expired.length === 1 ? "" : "es"}`;

  // A Toss all that succeeded but left expired batches behind, such as one
  // another phone added meanwhile, takes taps again once the list changes.
  useEffect(() => setTossingAll(false), [expiredIds]);

  const emptied = useLeaveWhenEmptied(expired.length > 0);

  const header = (
    <Stack.Screen
      options={{
        headerStyle: { backgroundColor: colors.bg },
        headerShadowVisible: false,
        headerTintColor: colors.text,
      }}
    />
  );

  if (inventory.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {header}
        <LoadingState />
      </View>
    );
  }

  if (inventory.isError && !inventory.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {header}
        <ErrorState onRetry={() => inventory.refetch()} />
      </View>
    );
  }

  if (emptied) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}</View>;
  }

  if (expired.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {header}
        <EmptyState
          icon={<FontAwesome name="check-circle" size={28} color={colors.ok} />}
          title="Nothing expired"
          message="Every batch in your kitchen is still in date."
        />
      </View>
    );
  }

  const tossAll = () => {
    if (tossingAll) return;
    setTossingAll(true);
    record(
      { lotIds: expired.map((e) => e.lot.id), outcome: "tossed", name: "Expired food" },
      () => setTossingAll(false),
    );
  };

  const confirmTossAll = () =>
    Alert.alert(`Toss ${batchCount}?`, "They are recorded as thrown out. You can undo right after.", [
      { text: "Cancel", style: "cancel" },
      { text: "Toss all", style: "destructive", onPress: tossAll },
    ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {header}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140, gap: 10 }}>
        <View style={{ marginBottom: 6 }}>
          <Text
            style={{ fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.4, color: colors.text }}
          >
            {batchCount}
          </Text>
          <Text style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
            Recipes and cooking skip these until you keep or toss them.
          </Text>
        </View>

        {expired.map((batch) => (
          <ExpiredLotCard key={batch.lot.id} batch={batch} disabled={tossingAll} />
        ))}
      </ScrollView>

      <TossAllFooter
        count={expired.length}
        disabled={tossingAll}
        onPress={confirmTossAll}
      />
    </View>
  );
}

/**
 * Pins Toss all to the bottom of the screen, away from the toasts at the top,
 * so a late tap on a toast's Undo cannot land on it.
 */
function TossAllFooter({
  count,
  disabled,
  onPress,
}: {
  count: number;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        padding: 16,
        paddingBottom: Math.max(insets.bottom, 16),
        backgroundColor: colors.bg,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Toss all"
        style={({ pressed }) => ({
          height: 50,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        })}
      >
        <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 14.5, color: colors.crit }}>
          Toss all {count}
        </Text>
      </Pressable>
    </View>
  );
}
