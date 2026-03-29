import { StyleSheet } from "react-native";
import { Text, View } from "@/components/Themed";

// ─── Inventory Screen ────────────────────────────────────────────────────────
// Will display all fridge/pantry items grouped by category with expiration info.
// Built in Phase 2 (Task 2.3).
export default function InventoryScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>🧊</Text>
      <Text style={styles.title}>Inventory</Text>
      <Text style={styles.subtitle}>
        Your fridge and pantry items will appear here.
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
