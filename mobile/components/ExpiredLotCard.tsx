import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { useKeepLot } from "@/hooks/useKeepLot";
import { useLotOutcome } from "@/hooks/useLotOutcome";
import type { DrawnLot } from "@/lib/foodRows";
import { formatAmount } from "@/lib/amount";
import { dateInDays, expiryLabel } from "@/lib/expiry";

type ExpiredLotCardProps = {
  /** The expired batch to review, with its (negative) days until expiry. */
  batch: DrawnLot;
  /** When true, the card takes no taps, such as while Toss all runs. */
  disabled?: boolean;
};

const KEEP_OPTIONS = [
  { label: "Tomorrow", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
] as const;

/**
 * Renders one expired batch for review: food name, amount, location and how
 * long ago it expired, with Still good and Toss. Still good swaps the actions
 * for a choice of new dates and saves the picked one through
 * {@link useKeepLot}. Toss records the batch through {@link useLotOutcome},
 * with undo. Each card owns its own mutations, so one card's failure re-enables
 * only that card. After an action, the card ignores taps until the list
 * refetches and drops it, or until the action fails.
 */
export default function ExpiredLotCard({ batch, disabled = false }: ExpiredLotCardProps) {
  const { colors, fonts, card } = useTheme();
  const { record } = useLotOutcome();
  const keep = useKeepLot();
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState(false);
  // A ref, not only state, so two taps in one frame cannot both fire.
  const firedRef = useRef(false);
  const { lot, days } = batch;

  const amount = formatAmount(lot.quantity, lot.unit, lot.is_estimate);
  const location = capitalize(lot.storage_location);
  const expiry = expiryLabel(days);
  const locked = done || disabled;

  const once = (action: (onError: () => void) => void) => () => {
    if (firedRef.current || disabled) return;
    firedRef.current = true;
    setDone(true);
    action(() => {
      firedRef.current = false;
      setDone(false);
    });
  };

  const toss = once((onError) =>
    record({ lotIds: [lot.id], outcome: "tossed", name: lot.name }, onError),
  );
  const keepFor = (keepDays: number) =>
    once((onError) =>
      keep.mutate(
        { id: lot.id, name: lot.name, expirationDate: dateInDays(keepDays) },
        { onError },
      ),
    );

  return (
    <View
      testID="expired-batch"
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        padding: 14,
        gap: 12,
        opacity: locked ? 0.5 : 1,
        shadowColor: card.shadowColor,
        shadowOffset: card.shadowOffset,
        shadowOpacity: card.shadowOpacity,
        shadowRadius: card.shadowRadius,
        elevation: card.elevation,
      }}
    >
      <View accessible accessibilityLabel={[lot.name, amount, location, expiry].join(", ")} style={{ gap: 4 }}>
        <Text
          numberOfLines={1}
          style={{ fontFamily: fonts.bodyStrong, fontSize: 15, color: colors.text, letterSpacing: -0.2 }}
        >
          {lot.name}
        </Text>
        <Text style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted }}>
          {amount} · {location}
        </Text>
        <Text style={{ fontFamily: fonts.body, fontSize: 12, color: colors.crit }}>{expiry}</Text>
      </View>

      {picking ? (
        <View style={{ gap: 8 }}>
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 11,
              color: colors.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}
          >
            Good until
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {KEEP_OPTIONS.map((option) => (
              <Chip
                key={option.days}
                label={option.label}
                onPress={keepFor(option.days)}
              />
            ))}
            <Pressable
              onPress={() => setPicking(false)}
              accessibilityRole="button"
              hitSlop={6}
              style={{ paddingHorizontal: 8, paddingVertical: 8 }}
            >
              <Text style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ActionButton
            label="Still good"
            color={colors.text}
            background={colors.surfaceAlt}
            onPress={() => !locked && setPicking(true)}
          />
          <ActionButton
            label="Toss"
            color={colors.crit}
            background={colors.surface}
            border={colors.border}
            onPress={toss}
          />
        </View>
      )}
    </View>
  );
}

function ActionButton({
  label,
  color,
  background,
  border = background,
  onPress,
}: {
  label: string;
  color: string;
  background: string;
  border?: string;
  onPress: () => void;
}) {
  const { fonts } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flex: 1,
        height: 44,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: background,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 14, color, letterSpacing: -0.1 }}>{label}</Text>
    </Pressable>
  );
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors, fonts } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 100,
        backgroundColor: colors.accentSoft,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 13, color: colors.accent, letterSpacing: -0.1 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
