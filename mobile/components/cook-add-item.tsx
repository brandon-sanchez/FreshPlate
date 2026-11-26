import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import FoodPhoto from "@/components/food-photo";
import { card } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { formatAmount } from "@/lib/amount";
import { matchAddable, type AddableFood } from "@/lib/cook-checklist";

type CookAddItemProps = {
  /** The household's foods with unexpired stock. */
  foods: readonly AddableFood[];
  /** Ids of the foods already on the checklist, which aren't suggested. */
  listed: ReadonlySet<string>;
  /** Called with the food the person picked. */
  onAdd: (food: AddableFood) => void;
  /** Called when the search field gains focus. */
  onInputFocus?: () => void;
  /** Called when the search field loses focus. */
  onInputBlur?: () => void;
};

/**
 * "Add item" on the done-cooking checklist: a live type-ahead over the
 * household's foods that suggests up to five matches as the person types.
 */
export default function CookAddItem({
  foods,
  listed,
  onAdd,
  onInputFocus,
  onInputBlur,
}: CookAddItemProps) {
  const { colors, fonts } = useTheme();
  const [query, setQuery] = useState("");
  const matches = matchAddable(foods, query, listed);

  return (
    <View style={[styles.card, card, { backgroundColor: colors.surface }]}>
      <View style={styles.inputRow}>
        <Feather name="plus" size={18} color={colors.accent} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder="Add item"
          placeholderTextColor={colors.textSubtle}
          accessibilityLabel="Add an item you used"
          autoCorrect={false}
          returnKeyType="done"
          testID="cook-add-item"
          style={[styles.input, { color: colors.text, fontFamily: fonts.body }]}
        />
      </View>
      {matches.map((food) => (
        <Pressable
          key={food.foodId}
          onPress={() => {
            onAdd(food);
            setQuery("");
          }}
          accessibilityRole="button"
          accessibilityLabel={`Add ${food.name}`}
          testID={`cook-add-${food.foodId}`}
          style={[styles.match, { borderColor: colors.border }]}
        >
          <FoodPhoto foodId={food.foodId} size={28} enabled />
          <Text
            numberOfLines={1}
            style={[styles.matchName, { color: colors.text, fontFamily: fonts.body }]}
          >
            {food.name}
          </Text>
          <Text style={[styles.matchStock, { color: colors.textMuted, fontFamily: fonts.body }]}>
            {formatAmount(food.available, food.unit, false, food.subUnit)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 14, paddingVertical: 4 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  input: { flex: 1, fontSize: 14, paddingVertical: 10 },
  match: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  matchName: { flex: 1, fontSize: 14 },
  matchStock: { fontSize: 12 },
});
