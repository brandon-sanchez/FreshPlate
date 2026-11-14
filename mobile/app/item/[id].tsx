import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import Slider from "@react-native-community/slider";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Toast from "react-native-toast-message";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/hooks/useTheme";
import SegmentedControl from "@/components/SegmentedControl";
import LoadingState from "@/components/LoadingState";
import ErrorState from "@/components/ErrorState";
import LotRemainingControl from "@/components/LotRemainingControl";
import { InventoryItem, useInventoryItems } from "@/hooks/useInventoryItems";
import { dateInDays, daysUntilExpiration } from "@/lib/expiry";
import { formatAmount } from "@/lib/amount";
import { FoodNameTakenError, useUpdateItem } from "@/hooks/useUpdateItem";
import { useDeleteItem } from "@/hooks/useDeleteItem";
import { useAuthStore } from "@/stores/auth";
import { getUrgency } from "@/constants/theme";

const STORAGE_OPTIONS = ["Fridge", "Freezer", "Pantry"] as const;
type StorageLocation = "fridge" | "freezer" | "pantry";

const MIN_DAYS = -7;
const MAX_DAYS = 90;

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, fonts } = useTheme();
  const householdId = useAuthStore((s) => s.householdId);
  const queryClient = useQueryClient();

  const inventory = useInventoryItems();
  const cached = queryClient.getQueryData<InventoryItem[]>([
    "inventory",
    householdId,
  ]);
  const item = useMemo(
    () =>
      (inventory.data ?? cached ?? []).find((i) => i.id === id) ?? null,
    [inventory.data, cached, id],
  );

  const updateItem = useUpdateItem();
  const deleteItem = useDeleteItem();

  const [name, setName] = useState("");
  const [expDays, setExpDays] = useState<number | null>(null);
  const [storage, setStorage] = useState<StorageLocation>("fridge");
  const [notes, setNotes] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!item || hydrated) return;
    setName(item.name);
    setExpDays(daysUntilExpiration(item.expiration_date));
    setStorage(item.storage_location);
    setNotes(item.notes ?? "");
    setHydrated(true);
  }, [item, hydrated]);

  if (inventory.isPending && !item) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Stack.Screen options={{ title: "" }} />
        <LoadingState />
      </View>
    );
  }

  if (!item) {
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

  const trimmedName = name.trim();
  const isValid = trimmedName.length > 0;
  const expirationISO = expDays === null ? null : dateInDays(expDays);
  const urgency = expDays === null ? null : getUrgency(expDays);
  const urgencyColor =
    urgency?.level === "crit"
      ? colors.crit
      : urgency?.level === "warn"
        ? colors.warn
        : colors.ok;

  const handleSave = () => {
    if (!isValid || updateItem.isPending) return;
    const trimmedNotes = notes.trim() || null;
    updateItem.mutate(
      {
        id: item.id,
        foodId: item.food_id,
        patch: {
          ...(trimmedName !== item.name && { name: trimmedName }),
          ...(expirationISO !== item.expiration_date && {
            expiration_date: expirationISO,
          }),
          ...(storage !== item.storage_location && { storage_location: storage }),
          ...(trimmedNotes !== item.notes && { notes: trimmedNotes }),
        },
      },
      {
        onSuccess: () => {
          Toast.show({ type: "success", text1: "Saved" });
          router.back();
        },
        onError: (error) =>
          Toast.show({
            type: "error",
            text1: "Couldn't save",
            text2:
              error instanceof FoodNameTakenError
                ? `Another item is already called ${trimmedName}.`
                : "Check your connection and try again.",
          }),
      },
    );
  };

  const handleDelete = () => {
    Alert.alert(
      "Delete this batch?",
      `This erases the batch of ${item.name}. Use it for a batch added by mistake. To record that food was eaten or thrown out, swipe the batch and choose Used up or Toss.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteItem.mutate(
              { id: item.id, name: item.name },
              { onSuccess: () => router.back() },
            ),
        },
      ],
    );
  };

  const iconName = (item.category?.icon ?? "circle-o") as React.ComponentProps<
    typeof FontAwesome
  >["name"];

  const storageLabel = capitalize(storage);

  const expHint =
    expDays === null
      ? "No expiration date"
      : expDays < 0
        ? `${Math.abs(expDays)} day${expDays === -1 ? "" : "s"} ago`
        : expDays === 0
          ? "Today"
          : `${expDays} day${expDays === 1 ? "" : "s"} from now`;

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
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 16 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            marginBottom: 4,
          }}
        >
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
              {item.name}
            </Text>
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: 13,
                color: colors.textMuted,
                marginTop: 2,
              }}
            >
              {`${item.category?.name ?? "Uncategorized"} · ${formatAmount(item.quantity, item.unit, item.is_estimate)}`}
            </Text>
          </View>
        </View>

        <LotRemainingControl lot={item} />

        <SectionLabel text="Name" />
        <TextInput
          value={name}
          // Mirrors the 80-character CHECK on foods.name.
          maxLength={80}
          onChangeText={setName}
          placeholder="Item name"
          placeholderTextColor={colors.textSubtle}
          style={{
            height: 48,
            paddingHorizontal: 14,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: trimmedName.length === 0 ? colors.crit : colors.border,
            backgroundColor: colors.surface,
            color: colors.text,
            fontFamily: fonts.body,
            fontSize: 15,
          }}
        />

        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginTop: 4,
          }}
        >
          <SectionLabel text="Expires in" inline />
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: 12,
              color: urgencyColor ?? colors.textSubtle,
            }}
          >
            {expHint}
          </Text>
        </View>
        <View
          style={{
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <Slider
            minimumValue={MIN_DAYS}
            maximumValue={MAX_DAYS}
            step={1}
            value={expDays ?? 7}
            onValueChange={(v) => setExpDays(Math.round(v))}
            minimumTrackTintColor={colors.accent}
            maximumTrackTintColor={colors.surfaceAlt}
            thumbTintColor={colors.accent}
          />
        </View>

        <SectionLabel text="Storage" />
        <SegmentedControl
          options={[...STORAGE_OPTIONS]}
          selected={storageLabel}
          onSelect={(v) => setStorage(v.toLowerCase() as StorageLocation)}
        />

        <SectionLabel text="Notes" />
        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Add a note (optional)"
          placeholderTextColor={colors.textSubtle}
          multiline
          style={{
            minHeight: 72,
            padding: 14,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            color: colors.text,
            fontFamily: fonts.body,
            fontSize: 14.5,
            textAlignVertical: "top",
          }}
        />
      </ScrollView>

      <View
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          flexDirection: "row",
          gap: 10,
          padding: 16,
          paddingBottom: 28,
          backgroundColor: colors.bg,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <Pressable
          onPress={handleDelete}
          disabled={deleteItem.isPending}
          style={{
            flex: 1,
            height: 50,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            alignItems: "center",
            justifyContent: "center",
            opacity: deleteItem.isPending ? 0.5 : 1,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 14.5,
              color: colors.crit,
            }}
          >
            {deleteItem.isPending ? "Deleting…" : "Delete"}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleSave}
          disabled={!isValid || updateItem.isPending}
          style={{
            flex: 1,
            height: 50,
            borderRadius: 12,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity: !isValid || updateItem.isPending ? 0.5 : 1,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 14.5,
              color: colors.accentInk,
            }}
          >
            {updateItem.isPending ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function SectionLabel({ text, inline }: { text: string; inline?: boolean }) {
  const { colors, fonts } = useTheme();
  return (
    <Text
      style={{
        fontFamily: fonts.bodyStrong,
        fontSize: 11,
        color: colors.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginTop: inline ? 0 : 8,
        marginBottom: inline ? 0 : -8,
      }}
    >
      {text}
    </Text>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
