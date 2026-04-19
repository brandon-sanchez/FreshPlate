import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuthStore } from "@/stores/auth";
import { useTheme } from "@/hooks/useTheme";

export default function ProfileScreen() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const { colors } = useTheme();

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
          } catch (error) {
            Alert.alert(
              "Sign Out Error",
              error instanceof Error ? error.message : "Something went wrong"
            );
          }
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={styles.infoSection}>
        <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
          <Text style={[styles.avatarText, { color: colors.accentInk }]}>
            {user?.email?.[0]?.toUpperCase() ?? "?"}
          </Text>
        </View>
        <Text style={[styles.email, { color: colors.textMuted }]}>
          {user?.email ?? "No email"}
        </Text>
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.signOutButton,
          { backgroundColor: colors.crit },
          pressed && styles.buttonPressed,
        ]}
        onPress={handleSignOut}
      >
        <Text style={[styles.signOutText, { color: colors.accentInk }]}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 40,
  },
  infoSection: {
    alignItems: "center",
    marginBottom: 40,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  avatarText: {
    fontSize: 32,
    fontWeight: "bold",
  },
  email: {
    fontSize: 16,
  },
  signOutButton: {
    height: 50,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonPressed: {
    opacity: 0.7,
  },
  signOutText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
