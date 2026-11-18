import { useRef, useState } from "react";
import { Keyboard, Pressable, Text, TextInput, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import SectionLabel from "@/components/SectionLabel";
import { useTheme } from "@/hooks/useTheme";
import {
  type UsedUpFood,
  useRecentlyUsedUp,
  useRestoreUsedUp,
} from "@/hooks/useRecentlyUsedUp";
import { parseExactAmount } from "@/lib/fillLevel";

type RecentlyUsedUpProps = {
  /** The inventory search text. Only foods whose name contains it are listed. */
  search: string;
  /** Receives the restored batch's lot id once a restore succeeds. */
  onRestored: (lotId: string) => void;
};

const SLOP = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Renders the inventory's collapsed "Recently used up" section, which lists
 * the foods the household ran out of in the last 14 days. Each food's Restore
 * pill asks how much is left and restores it through
 * {@link useRecentlyUsedUp}. Renders nothing when no food matches.
 */
export default function RecentlyUsedUp({ search, onRestored }: RecentlyUsedUpProps) {
  const { colors, fonts } = useTheme();
  const usedUp = useRecentlyUsedUp();
  const [open, setOpen] = useState(false);

  const needle = search.trim().toLowerCase();
  const foods = (usedUp.data ?? []).filter((food) => food.name.toLowerCase().includes(needle));
  if (foods.length === 0) return null;

  const count = `${foods.length} food${foods.length === 1 ? "" : "s"}`;
  return (
    <View>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={`Recently used up, ${count}`}
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 14, paddingBottom: 8 }}
      >
        <FontAwesome name={open ? "angle-down" : "angle-right"} size={14} color={colors.textMuted} />
        <Text
          style={{
            fontFamily: fonts.bodyStrong,
            fontSize: 12,
            color: colors.textMuted,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Recently used up
        </Text>
        <Text style={{ fontFamily: fonts.body, fontSize: 11, color: colors.textSubtle }}>
          {foods.length}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 6 }}>
          {foods.map((food) => (
            <UsedUpRow
              key={food.lotId}
              food={food}
              onRestored={onRestored}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

type UsedUpRowProps = {
  food: UsedUpFood;
  onRestored: (lotId: string) => void;
};

function UsedUpRow({ food, onRestored }: UsedUpRowProps) {
  const { colors, fonts, card } = useTheme();
  const restore = useRestoreUsedUp({ onRestored });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  // A ref, not only mutation state, so two taps in one frame cannot both restore.
  const firedRef = useRef(false);
  const amount = parseExactAmount(text, food.wholeUnitsOnly);
  // Stays busy after success until the refetch drops the row.
  const busy = restore.isPending || restore.isSuccess;

  const confirm = () => {
    if (amount === null || firedRef.current) return;
    firedRef.current = true;
    Keyboard.dismiss();
    restore.mutate(
      { food, quantity: amount },
      { onError: () => (firedRef.current = false) },
    );
  };

  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        shadowColor: card.shadowColor,
        shadowOffset: card.shadowOffset,
        shadowOpacity: card.shadowOpacity,
        shadowRadius: card.shadowRadius,
        elevation: card.elevation,
        padding: 12,
        gap: 12,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: fonts.bodyStrong, fontSize: 15, color: colors.text, letterSpacing: -0.2 }}
          >
            {food.name}
          </Text>
          <Text style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted }}>
            {usedUpLabel(food.depletedAt)}
          </Text>
        </View>
        <Pressable
          onPress={() => !busy && setEditing((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={`Restore ${food.name}`}
          accessibilityState={{ expanded: editing, disabled: busy }}
          hitSlop={SLOP}
          style={({ pressed }) => ({
            height: 32,
            paddingHorizontal: 12,
            borderRadius: 100,
            borderWidth: 1,
            borderColor: colors.accent,
            backgroundColor: editing ? colors.accentSoft : "transparent",
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 13, color: colors.accent, letterSpacing: -0.1 }}>
            Restore
          </Text>
        </Pressable>
      </View>

      {editing ? (
        <View style={{ gap: 8 }}>
          <SectionLabel text="How much is left?" inline />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View
              style={{
                flex: 1,
                height: 44,
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 14,
                borderRadius: 12,
                backgroundColor: colors.surfaceAlt,
              }}
            >
              <TextInput
                value={text}
                onChangeText={setText}
                onSubmitEditing={confirm}
                autoFocus
                editable={!busy}
                placeholder="Amount left"
                placeholderTextColor={colors.textSubtle}
                keyboardType={food.wholeUnitsOnly ? "number-pad" : "decimal-pad"}
                returnKeyType="done"
                accessibilityLabel={`Amount of ${food.name} left, in ${food.unit}`}
                style={{ flex: 1, color: colors.text, fontFamily: fonts.body, fontSize: 15 }}
              />
              <Text style={{ fontFamily: fonts.body, fontSize: 14, color: colors.textMuted }}>
                {food.unit}
              </Text>
            </View>
            <Pressable
              onPress={confirm}
              disabled={amount === null || busy}
              accessibilityRole="button"
              accessibilityLabel={`Confirm restoring ${food.name}`}
              accessibilityState={{ disabled: amount === null || busy }}
              style={{
                height: 44,
                paddingHorizontal: 18,
                borderRadius: 12,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
                opacity: amount === null || busy ? 0.5 : 1,
              }}
            >
              <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 14.5, color: colors.accentInk }}>
                Restore
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function usedUpLabel(depletedAt: string): string {
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(depletedAt))) / DAY_MS);
  if (days <= 0) return "Used up today";
  if (days === 1) return "Used up yesterday";
  return `Used up ${days} days ago`;
}
