import { useState } from "react";
import { Keyboard, Pressable, Text, TextInput, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Toast from "react-native-toast-message";
import { useTheme } from "@/hooks/useTheme";
import ChoiceChips, { type Choice } from "@/components/ChoiceChips";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { useCutLot } from "@/hooks/useCutLot";
import { formatAmount } from "@/lib/amount";
import { dateInDays, daysUntilExpiration } from "@/lib/expiry";
import { parseExactAmount } from "@/lib/fillLevel";

type CutLotControlProps = {
  /** The batch to cut part of. */
  lot: InventoryItem;
  /** Called after the cut is saved, so the screen can leave the editor. */
  onCut: () => void;
};

const SHORTER_DAYS = [5, 3, 1] as const;

/**
 * Renders a collapsed "Cut up or open part" row that expands in place into a
 * form for cutting up or opening part of a batch, such as one sliced apple of
 * five, into its own opened batch that cooking uses first. The person types
 * the amount and picks how soon to use the cut part: the batch's own date or a
 * sooner one, never a later one.
 */
function CutLotControl({ lot, onCut }: CutLotControlProps) {
  const { colors, fonts } = useTheme();
  const cutLot = useCutLot();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [days, setDays] = useState<number | null>(null);

  const lotDays = daysUntilExpiration(lot.expiration_date);
  const sooner = SHORTER_DAYS.filter((d) => lotDays === null || d < lotDays);
  const parsed = parseExactAmount(typed, lot.whole_units_only);
  const amount = parsed !== null && parsed <= lot.quantity ? parsed : null;
  const busy = cutLot.isPending;

  const submit = () => {
    if (amount === null || busy) return;
    cutLot.mutate(
      { lot, quantity: amount, expirationDate: days === null ? null : dateInDays(days) },
      {
        onSuccess: () => {
          Keyboard.dismiss();
          Toast.show(
            amount === lot.quantity
              ? { type: "success", text1: `Opened ${lot.name}`, text2: "It's used first." }
              : {
                  type: "success",
                  text1: `Cut up ${formatAmount(amount, lot.unit, false)} of ${lot.name}`,
                  text2: "It's its own opened batch, used first.",
                },
          );
          onCut();
        },
      },
    );
  };

  const choices: Choice<number | null>[] = [
    { key: "same", label: lot.expiration_date === null ? "No date" : "Same date", value: null },
    ...sooner.map((d) => ({ key: String(d), label: `${d} day${d === 1 ? "" : "s"}`, value: d })),
  ];

  const toggle = (
    <Pressable
      onPress={() => setOpen((o) => !o)}
      accessibilityRole="button"
      accessibilityLabel="Cut up or open part"
      accessibilityState={{ expanded: open }}
      style={{
        height: 48,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <Text style={{ fontFamily: fonts.body, fontSize: 15, color: colors.text }}>
        Cut up or open part
      </Text>
      <Feather
        name={open ? "chevron-down" : "chevron-right"}
        size={18}
        color={colors.textMuted}
      />
    </Pressable>
  );

  if (!open) return toggle;

  return (
    <>
      {toggle}
      <View
        style={{
          height: 48,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        }}
      >
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder={`Amount, up to ${formatAmount(lot.quantity, lot.unit, false)}`}
          placeholderTextColor={colors.textSubtle}
          keyboardType={lot.whole_units_only ? "number-pad" : "decimal-pad"}
          returnKeyType="done"
          accessibilityLabel={`Amount to cut up, in ${lot.unit}`}
          style={{ flex: 1, color: colors.text, fontFamily: fonts.body, fontSize: 15 }}
        />
        <Text style={{ fontFamily: fonts.body, fontSize: 14, color: colors.textMuted }}>
          {lot.unit}
        </Text>
      </View>
      <Text style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted }}>
        Use within
      </Text>
      <View style={{ marginTop: -8 }}>
        <ChoiceChips choices={choices} selected={days} onSelect={setDays} />
      </View>
      <Pressable
        onPress={submit}
        disabled={amount === null || busy}
        accessibilityRole="button"
        accessibilityLabel="Cut up"
        style={{
          height: 48,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
          opacity: amount === null || busy ? 0.5 : 1,
        }}
      >
        <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 14.5, color: colors.accent }}>
          {busy ? "Cutting…" : "Cut up"}
        </Text>
      </Pressable>
    </>
  );
}

export default CutLotControl;
