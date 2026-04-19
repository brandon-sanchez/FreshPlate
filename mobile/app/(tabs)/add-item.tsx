import {
  StyleSheet,
  TextInput,
  ScrollView,
  Text,
  View,
  Pressable,
} from "react-native";
import { useState } from "react";
import SegmentedControl from "@/components/SegmentedControl";
import PickerModal from "@/components/PickerModal";
import { useTheme } from "@/hooks/useTheme";

export default function AddItemScreen() {
  const [storage, setStorage] = useState("Fridge");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("item");
  const [expirationDate, setExpirationDate] = useState(new Date());
  const [notes, setNotes] = useState("");
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [showUnitPicker, setShowUnitPicker] = useState(false);

  const { colors, spacing } = useTheme();

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: colors.bg }]}>
      <Text style={[styles.title, { color: colors.text }]}>Add Item</Text>
      <TextInput
        placeholder="What are you adding?"
        placeholderTextColor={colors.textSubtle}
        value={name}
        onChangeText={setName}
        style={[styles.input, { borderColor: colors.border, backgroundColor: colors.surface, color: colors.text }]}
      />
      <Text style={[styles.label, { color: colors.textMuted }]}>Category</Text>
      <Pressable
        style={[styles.input, { borderColor: colors.border, backgroundColor: colors.surface }]}
        onPress={() => setShowCategoryPicker(true)}
      >
        <Text style={{ color: category ? colors.text : colors.textSubtle }}>
          {category || "Select a category"}
        </Text>
      </Pressable>
      <PickerModal
        visible={showCategoryPicker}
        onClose={() => setShowCategoryPicker(false)}
        title="Select Category"
        options={[
          "Produce",
          "Dairy & Eggs",
          "Meat & Seafood",
          "Frozen",
          "Grains & Bread",
          "Canned Goods",
          "Condiments",
          "Snacks",
          "Beverages",
          "Leftovers",
          "Other",
        ]}
        onSelect={setCategory}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "bold",
    marginBottom: 8,
  },
  input: {
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    fontSize: 16,
    justifyContent: "center",
  },
  label: {
    fontSize: 14,
    marginBottom: 8,
    marginTop: 20,
  },
});
