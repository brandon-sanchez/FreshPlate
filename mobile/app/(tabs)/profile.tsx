import { Alert, Pressable, StyleSheet } from "react-native";
import { Text, View } from "@/components/Themed";
import { useAuthStore } from "@/stores/auth";

// ─── Profile Screen ──────────────────────────────────────────────────────────
// Shows the signed-in user's info and a sign-out button.
// Will eventually include household management and preferences (Phases 7-8).
export default function ProfileScreen() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

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
    <View style={styles.container}>
      {/* User info section */}
      <View style={styles.infoSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {user?.email?.[0]?.toUpperCase() ?? "?"}
          </Text>
        </View>
        <Text style={styles.email}>{user?.email ?? "No email"}</Text>
      </View>

      {/* Sign out */}
      <Pressable
        style={({ pressed }) => [
          styles.signOutButton,
          pressed && styles.buttonPressed,
        ]}
        onPress={handleSignOut}
      >
        <Text style={styles.signOutText}>Sign Out</Text>
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
    backgroundColor: "#2f95dc",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  avatarText: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#fff",
  },
  email: {
    fontSize: 16,
    opacity: 0.7,
  },
  signOutButton: {
    backgroundColor: "#ff3b30",
    height: 50,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonPressed: {
    opacity: 0.7,
  },
  signOutText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
