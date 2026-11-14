import { useState } from "react";
import { Keyboard, Pressable, Text, TextInput, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import SegmentedControl from "@/components/SegmentedControl";
import type { InventoryItem } from "@/hooks/useInventoryItems";
import { useSetLotRemaining } from "@/hooks/useSetLotRemaining";
import {
  FILL_LEVELS,
  currentFillLevel,
  parseExactAmount,
  remainingMode,
} from "@/lib/fillLevel";

type LotRemainingControlProps = {
  /** The batch whose remaining amount the control sets. */
  lot: InventoryItem;
};

/**
 * Renders an "Amount left" section that sets how much of a batch is left: an
 * exact amount in the food's unit, and directly under it a How full control
 * (Full, ¾, ½ or ¼ of the full size) that saves on each tap. How full is
 * hidden for a batch with no known full size and for a food counted in whole
 * units. Used up is a swipe action and is not offered here, so a fill tap
 * never empties a batch.
 */
function LotRemainingControl({ lot }: LotRemainingControlProps) {
  const { colors, fonts } = useTheme();
  const setRemaining = useSetLotRemaining();
  const [exact, setExact] = useState("");

  const mode = remainingMode(lot);
  const current = currentFillLevel(lot);
  const amount = parseExactAmount(exact, lot.whole_units_only);
  const busy = setRemaining.isPending;

  const submitExact = () => {
    if (amount === null || busy) return;
    setRemaining.mutate(
      { lot, remaining: { quantity: amount } },
      {
        onSuccess: () => {
          setExact("");
          Keyboard.dismiss();
        },
      },
    );
  };

  return (
    <>
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 11,
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          marginTop: 8,
          marginBottom: -8,
        }}
      >
        Amount left
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          style={{
            flex: 1,
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
            value={exact}
            onChangeText={setExact}
            onSubmitEditing={submitExact}
            placeholder="Exact amount left"
            placeholderTextColor={colors.textSubtle}
            keyboardType={mode === "count" ? "number-pad" : "decimal-pad"}
            returnKeyType="done"
            accessibilityLabel={`Exact amount left, in ${lot.unit}`}
            style={{ flex: 1, color: colors.text, fontFamily: fonts.body, fontSize: 15 }}
          />
          <Text style={{ fontFamily: fonts.body, fontSize: 14, color: colors.textMuted }}>
            {lot.unit}
          </Text>
        </View>
        <Pressable
          onPress={submitExact}
          disabled={amount === null || busy}
          accessibilityRole="button"
          style={{
            height: 48,
            paddingHorizontal: 18,
            borderRadius: 12,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity: amount === null || busy ? 0.5 : 1,
          }}
        >
          <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 14.5, color: colors.accentInk }}>
            Set
          </Text>
        </Pressable>
      </View>
      {mode === "levels" ? (
        <SegmentedControl
          options={FILL_LEVELS.map((level) => level.label)}
          selected={current?.label ?? ""}
          onSelect={(label) => {
            const level = FILL_LEVELS.find((l) => l.label === label);
            if (!level || busy || level === current) return;
            setRemaining.mutate({ lot, remaining: { fraction: level.fraction } });
          }}
        />
      ) : null}
    </>
  );
}

export default LotRemainingControl;
