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

// ─── Add Item Screen ─────────────────────────────────────────────────────────
// Will provide three ways to add items: manual entry, barcode scan, photo.
// Built across Phase 2 (manual), Phase 3 (barcode), and Phase 4 (photo).
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

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Add Item</Text>
      <TextInput
        placeholder="What are you adding?"
        value={name}
        onChangeText={setName}
        style={styles.inputStyle}
      />
      <Text style={styles.label}>Category</Text>
      <Pressable
        style={styles.inputStyle}
        onPress={() => setShowCategoryPicker(true)}
      >
        <Text>{category || "Select a category"}</Text>
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
  inputStyle: {
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E2E0DC",
    paddingHorizontal: 16,
    fontSize: 16,
    backgroundColor: "#FFFFFF",
  },
  label: {
    fontSize: 14,
    color: "#3D3D38",
    marginBottom: 8,
    marginTop: 20,
  },
});
