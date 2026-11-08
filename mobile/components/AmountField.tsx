import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Chip from "@/components/Chip";
import Field from "@/components/Field";
import { useTheme } from "@/hooks/useTheme";
import type { KnownFood } from "@/lib/knownFood";
import {
  AmountDraft,
  packageWordChoices,
  trackingNote,
  unitChips,
  withSizeAmount,
  withSizeUnit,
} from "@/lib/lotAmount";
import { measuresFor } from "@/lib/stockUnit";

type AmountFieldProps = {
  /** The amount as entered so far, already fitted to `food`. */
  value: AmountDraft;
  /** Receives the whole next draft on every chip press, step, or keystroke. */
  onChange: (next: AmountDraft) => void;
  /**
   * The food the typed name matches, or `null` for a new food. A known food
   * limits the unit chips to its stock base.
   */
  food: KnownFood | null;
  /** Message shown under the amount, such as a missing package size. */
  error?: string;
};

/**
 * The add form's amount control: unit chips, then a stepper for counts or a
 * number field for weights and volumes, and for a package its word and size.
 */
export default function AmountField({
  value,
  onChange,
  food,
  error,
}: AmountFieldProps) {
  const { colors } = useTheme();
  const inputStyle = [
    styles.input,
    {
      borderColor: error ? colors.crit : colors.border,
      backgroundColor: colors.surface,
      color: colors.text,
    },
  ];

  return (
    <>
      <Field label="Unit" hint={food ? trackingNote(food) : undefined}>
        <View style={styles.chipRow}>
          {unitChips(food, value).map((chip) => (
            <Chip
              key={chip.label}
              label={chip.label}
              state={chip.selected ? "on" : "off"}
              onPress={() => onChange(chip.draft)}
            />
          ))}
        </View>
      </Field>

      {value.kind === "package" ? (
        <Field label="Package">
          <View style={styles.chipRow}>
            {packageWordChoices(value).map((word) => (
              <Chip
                key={word.label}
                label={word.label}
                state={word.selected ? "on" : "off"}
                onPress={() => onChange(word.draft)}
              />
            ))}
          </View>
        </Field>
      ) : null}

      <Field
        label={value.kind === "package" ? "How many" : "Amount"}
        error={error}
      >
        {value.kind === "measure" ? (
          <TextInput
            accessibilityLabel="Amount"
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={colors.textSubtle}
            value={value.amount}
            onChangeText={(amount) => onChange({ ...value, amount })}
            style={inputStyle}
          />
        ) : (
          <Stepper
            count={value.count}
            onChange={(count) => onChange({ ...value, count })}
          />
        )}
      </Field>

      {value.kind === "package" ? (
        <Field label="Package size" hint={food ? undefined : "Optional"}>
          <View style={styles.sizeRow}>
            <TextInput
              accessibilityLabel="Package size"
              keyboardType="decimal-pad"
              placeholder="Size of one"
              placeholderTextColor={colors.textSubtle}
              value={value.size?.amount ?? ""}
              onChangeText={(amount) =>
                onChange(withSizeAmount(value, amount, food))
              }
              style={[inputStyle, styles.sizeInput]}
            />
            {measuresFor(
              food && food.stock.base !== "each" ? food.stock.base : null,
            ).map((unit) => (
              <Chip
                key={unit}
                label={unit}
                accessibilityLabel={`Package size in ${unit}`}
                state={value.size?.unit === unit ? "on" : "off"}
                onPress={() => onChange(withSizeUnit(value, unit))}
              />
            ))}
          </View>
        </Field>
      ) : null}
    </>
  );
}

function Stepper({
  count,
  onChange,
}: {
  count: number;
  onChange: (count: number) => void;
}) {
  const { colors } = useTheme();
  const atMinimum = count <= 1;

  return (
    <View
      style={[
        styles.stepper,
        { borderColor: colors.border, backgroundColor: colors.surface },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Decrease count"
        accessibilityState={{ disabled: atMinimum }}
        disabled={atMinimum}
        onPress={() => onChange(count - 1)}
        style={[styles.stepButton, { backgroundColor: colors.surfaceAlt }]}
      >
        <FontAwesome
          name="minus"
          size={12}
          color={atMinimum ? colors.textSubtle : colors.text}
        />
      </Pressable>
      <Text style={[styles.count, { color: colors.text }]}>{count}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase count"
        onPress={() => onChange(count + 1)}
        style={[styles.stepButton, { backgroundColor: colors.surfaceAlt }]}
      >
        <FontAwesome name="plus" size={12} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  input: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  sizeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sizeInput: {
    flex: 1,
    marginRight: 4,
  },
  stepper: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  count: {
    fontSize: 16,
    fontWeight: "600",
  },
});
