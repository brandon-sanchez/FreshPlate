import { StyleSheet } from "react-native";
import { Text, View } from "@/components/Themed";

// ─── Recipes Screen ──────────────────────────────────────────────────────────
// Will show AI-generated recipe suggestions based on current inventory.
// Built in Phase 5 (Task 5.3).
export default function RecipesScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>👨‍🍳</Text>
      <Text style={styles.title}>Recipes</Text>
      <Text style={styles.subtitle}>
        AI recipe suggestions based on your fridge will appear here.
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
