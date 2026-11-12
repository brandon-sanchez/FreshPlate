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
  type RemainingMode,
} from "@/lib/fillLevel";

type LotRemainingControlProps = {
  /** The batch whose remaining amount the control sets. */
  lot: InventoryItem;
};

const SECTION_LABEL: Record<RemainingMode, string> = {
  levels: "How full",
  unknownSize: "Amount left",
  count: "Amount left",
};

/**
 * Renders a labelled section that sets how much of a batch is left, saving on
 * each tap: Full, 3/4, 1/2 or 1/4 of its full size, or an exact amount in the
 * food's unit. A batch with no known full size, or of a food counted in whole
 * units, offers only the exact amount. Used up is a swipe action and is not
 * offered here, so a fill tap never empties a batch.
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
        {SECTION_LABEL[mode]}
      </Text>
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
      {mode === "unknownSize" ? (
        <Text style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted }}>
          Full size unknown, so enter how much is left.
        </Text>
      ) : null}
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
    </>
  );
}

export default LotRemainingControl;
