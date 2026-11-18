import { Pressable, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import FoodPhoto from "@/components/food-photo";
import { useTheme } from "@/hooks/useTheme";
import {
  formatStock,
  stepAmount,
  type ChecklistLine,
} from "@/lib/cook-checklist";
import { card } from "@/constants/theme";

type CookChecklistCardProps = {
  /** The food, its stock and the amount the person says they used. */
  line: ChecklistLine;
  /** Called with the new amount when the stepper moves. */
  onChangeAmount: (amount: number) => void;
  /** Shows a remove button when set, for foods added with "Add item". */
  onRemove?: () => void;
};

/**
 * One food on the done-cooking checklist: "You have X → after: Y", any note
 * about the pre-filled amount, and a stepper for the amount used.
 */
export default function CookChecklistCard({
  line,
  onChangeAmount,
  onRemove,
}: CookChecklistCardProps) {
  const { colors, fonts } = useTheme();
  const after = Math.max(0, line.available - line.amount);
  const notes = checklistNotes(line);

  return (
    <View
      testID={`cook-line-${line.foodId}`}
      style={[styles.card, card, { backgroundColor: colors.surface }]}
    >
      <View style={styles.row}>
        <FoodPhoto foodId={line.foodId} size={40} enabled />
        <View style={styles.copy}>
          <Text
            style={[styles.name, { color: colors.text, fontFamily: fonts.bodyStrong }]}
          >
            {line.name}
          </Text>
          <Text
            style={[styles.stock, { color: colors.textMuted, fontFamily: fonts.body }]}
          >
            You have {formatStock(line.available, line.unit, false)} → after:{" "}
            {formatStock(after, line.unit, line.estimated)}
          </Text>
        </View>
        <View style={styles.stepper}>
          <StepButton
            icon="minus"
            label={`Use less ${line.name}`}
            disabled={line.amount <= 0}
            onPress={() => onChangeAmount(stepAmount(line, -1))}
          />
          <Text
            accessibilityLabel={`${formatStock(line.amount, line.unit, false)} used`}
            style={[styles.amount, { color: colors.text, fontFamily: fonts.bodyStrong }]}
          >
            {formatStock(line.amount, line.unit, false)}
          </Text>
          <StepButton
            icon="plus"
            label={`Use more ${line.name}`}
            onPress={() => onChangeAmount(stepAmount(line, 1))}
          />
        </View>
      </View>
      {notes.map((note) => (
        <Text
          key={note.text}
          style={[
            styles.note,
            {
              color: note.changed ? colors.crit : colors.textMuted,
              fontFamily: note.changed ? fonts.bodyStrong : fonts.body,
            },
          ]}
        >
          {note.text}
        </Text>
      ))}
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${line.name}`}
          hitSlop={8}
          style={styles.remove}
        >
          <Feather name="x" size={13} color={colors.textMuted} />
          <Text style={[styles.note, { color: colors.textMuted, fontFamily: fonts.bodyStrong }]}>
            Remove
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function StepButton({
  icon,
  label,
  disabled = false,
  onPress,
}: {
  icon: "minus" | "plus";
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={7}
      style={[
        styles.stepButton,
        { backgroundColor: colors.accent, opacity: disabled ? 0.4 : 1 },
      ]}
    >
      <Feather name={icon} size={16} color={colors.accentInk} />
    </Pressable>
  );
}

type Note = { text: string; changed: boolean };

function checklistNotes(line: ChecklistLine): Note[] {
  const notes: Note[] = [];
  if (line.changed) notes.push({ text: line.changed, changed: true });
  if (line.roundingNote) notes.push({ text: line.roundingNote, changed: false });
  for (const asked of line.planLines.filter((planLine) => planLine.mode === "ask")) {
    const said =
      asked.recipe_amount > 0
        ? `${asked.recipe_amount} ${asked.recipe_unit}`
        : asked.recipe_unit;
    notes.push({
      text: `Recipe says ${said} of ${asked.ingredient}. Set how much you used.`,
      changed: false,
    });
  }
  const seasoningOnly =
    line.planLines.length > 0 &&
    line.planLines.every((planLine) => planLine.mode === "small");
  if (seasoningOnly && line.amount === 0) {
    notes.push({ text: "Just a little, so nothing is deducted", changed: false });
  }
  return notes;
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 14, lineHeight: 19 },
  stock: { fontSize: 12, lineHeight: 16 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  stepButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  amount: {
    minWidth: 56,
    textAlign: "center",
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  remove: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  note: { fontSize: 12, lineHeight: 16 },
});
