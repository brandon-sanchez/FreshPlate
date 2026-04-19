import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";

export default function RecipesScreen() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Text style={styles.emoji}>👨‍🍳</Text>
      <Text style={[styles.title, { color: colors.text }]}>Recipes</Text>
      <Text style={[styles.subtitle, { color: colors.textMuted }]}>
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
    textAlign: "center",
  },
});
