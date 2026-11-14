import { useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useTheme } from "@/hooks/useTheme";
import { useKeepLot } from "@/hooks/useKeepLot";
import { useLotOutcome } from "@/hooks/useLotOutcome";
import type { DrawnLot } from "@/lib/foodRows";
import { formatAmount } from "@/lib/amount";
import { dateInDays, expiryLabel, formatShortDate, toLocalIsoDate } from "@/lib/expiry";

type ExpiredLotRowProps = {
  /** The expired batch to review, with its (negative) days until expiry. */
  batch: DrawnLot;
  /** When true, the row takes no taps, such as while Toss all runs. */
  disabled?: boolean;
};

const KEEP_OPTIONS = [
  { label: "Tomorrow", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
] as const;

/** Controls are 32 pt tall; this slop on each side brings the touch target to 44 pt. */
const SLOP = 6;

/**
 * Renders one expired batch as a row of the review list: food name, amount
 * and how long ago it expired, with Still good and Toss on the right. Still
 * good opens a choice of new dates below the row, or an exact date from a
 * calendar, and saves the pick through {@link useKeepLot}. Toss records the
 * batch through {@link useLotOutcome}, with undo. Each row owns its own
 * mutations, so one row's failure re-enables only that row. After an action,
 * the row ignores taps until the list refetches and drops it, or until the
 * action fails.
 */
export default function ExpiredLotRow({ batch, disabled = false }: ExpiredLotRowProps) {
  const { colors, fonts, colorScheme } = useTheme();
  const { record } = useLotOutcome();
  const keep = useKeepLot();
  const [picking, setPicking] = useState(false);
  const [exactDate, setExactDate] = useState<Date | null>(null);
  const [done, setDone] = useState(false);
  // A ref, not only state, so two taps in one frame cannot both fire.
  const firedRef = useRef(false);
  const { lot, days } = batch;

  const amount = formatAmount(lot.quantity, lot.unit, lot.is_estimate);
  const expiry = expiryLabel(days);
  const locked = done || disabled;

  const once = (action: (onError: () => void) => void) => {
    if (firedRef.current || disabled) return;
    firedRef.current = true;
    setDone(true);
    action(() => {
      firedRef.current = false;
      setDone(false);
    });
  };

  const toss = () =>
    once((onError) => record({ lotIds: [lot.id], outcome: "tossed", name: lot.name }, onError));
  const keepUntil = (expirationDate: string) =>
    once((onError) => keep.mutate({ id: lot.id, name: lot.name, expirationDate }, { onError }));

  const closePicker = () => {
    setPicking(false);
    setExactDate(null);
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const pickExactDate = () => {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
    // Android shows the calendar as a system dialog, where setting a date is
    // the confirmation. iOS shows it inline, followed by a Keep until chip.
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: start,
        mode: "date",
        minimumDate: today,
        onChange: (event, date) => {
          if (event.type === "set" && date) keepUntil(toLocalIsoDate(date));
        },
      });
    } else {
      setExactDate(start);
    }
  };

  return (
    <View
      testID="expired-batch"
      style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 12, opacity: locked ? 0.5 : 1 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          accessible
          accessibilityLabel={[lot.name, amount, expiry].join(", ")}
          style={{ flex: 1, minWidth: 0, gap: 2 }}
        >
          <Text
            numberOfLines={1}
            style={{ fontFamily: fonts.bodyStrong, fontSize: 15, color: colors.text, letterSpacing: -0.2 }}
          >
            {lot.name}
          </Text>
          <Text style={{ fontFamily: fonts.body, fontSize: 12.5, color: colors.textMuted }}>{amount}</Text>
          <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 12, color: colors.crit }}>{expiry}</Text>
        </View>

        <Pressable
          onPress={() => !locked && (picking ? closePicker() : setPicking(true))}
          accessibilityRole="button"
          accessibilityState={{ expanded: picking }}
          hitSlop={SLOP}
          style={({ pressed }) => ({
            height: 32,
            paddingHorizontal: 12,
            borderRadius: 100,
            borderWidth: 1,
            borderColor: colors.accent,
            backgroundColor: picking ? colors.accentSoft : "transparent",
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 13, color: colors.accent, letterSpacing: -0.1 }}>
            Still good
          </Text>
        </Pressable>
        <Pressable
          onPress={toss}
          accessibilityRole="button"
          hitSlop={SLOP}
          style={({ pressed }) => ({
            height: 32,
            paddingHorizontal: 6,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 13, color: colors.crit, letterSpacing: -0.1 }}>
            Toss
          </Text>
        </Pressable>
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
          {exactDate ? (
            <>
              <DateTimePicker
                testID="keep-date-picker"
                value={exactDate}
                mode="date"
                display="inline"
                minimumDate={today}
                accentColor={colors.accent}
                themeVariant={colorScheme === "dark" ? "dark" : "light"}
                onChange={(_event, date) => date && setExactDate(date)}
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Chip
                  label={`Keep until ${formatShortDate(toLocalIsoDate(exactDate))}`}
                  onPress={() => keepUntil(toLocalIsoDate(exactDate))}
                />
                <CancelLink onPress={closePicker} />
              </View>
            </>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {KEEP_OPTIONS.map((option) => (
                <Chip
                  key={option.days}
                  label={option.label}
                  onPress={() => keepUntil(dateInDays(option.days))}
                />
              ))}
              <Chip label="Pick a date…" onPress={pickExactDate} />
              <CancelLink onPress={closePicker} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors, fonts } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={SLOP}
      style={({ pressed }) => ({
        height: 32,
        paddingHorizontal: 14,
        borderRadius: 100,
        backgroundColor: colors.accentSoft,
        justifyContent: "center",
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 13, color: colors.accent, letterSpacing: -0.1 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function CancelLink({ onPress }: { onPress: () => void }) {
  const { colors, fonts } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={SLOP}
      style={{ height: 32, paddingHorizontal: 8, justifyContent: "center" }}
    >
      <Text style={{ fontFamily: fonts.body, fontSize: 13, color: colors.textMuted }}>Cancel</Text>
    </Pressable>
  );
}
