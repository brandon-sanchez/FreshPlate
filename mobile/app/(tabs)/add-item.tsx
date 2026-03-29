import { StyleSheet } from "react-native";
import { Text, View } from "@/components/Themed";

// ─── Add Item Screen ─────────────────────────────────────────────────────────
// Will provide three ways to add items: manual entry, barcode scan, photo.
// Built across Phase 2 (manual), Phase 3 (barcode), and Phase 4 (photo).
export default function AddItemScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>➕</Text>
      <Text style={styles.title}>Add Item</Text>
      <Text style={styles.subtitle}>
        Add items by typing, scanning, or taking a photo.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "bold",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    opacity: 0.6,
    textAlign: "center",
  },
});
