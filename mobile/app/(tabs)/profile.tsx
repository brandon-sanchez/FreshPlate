import { ReactNode, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import { useAuthStore, firstNameFromMetadata } from "@/stores/auth";
import { useTheme } from "@/hooks/useTheme";
import { firstNameFromProfile, useProfile } from "@/hooks/useProfile";

const DIETARY_TAGS = [
  "Vegetarian",
  "Vegan",
  "Gluten-free",
  "Dairy-free",
  "Pescatarian",
  "Keto",
] as const;

const PLACEHOLDER_TASTE = [
  "Comfort food",
  "Quick weeknights",
  "Low-effort",
  "One-pan",
] as const;

export default function ProfileScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const profile = useProfile();

  const displayFirst =
    firstNameFromProfile(profile.data?.display_name) ??
    firstNameFromMetadata(user);
  const displayFull = profile.data?.display_name?.trim() ?? displayFirst ?? null;

  const [expirationAlerts, setExpirationAlerts] = useState(true);
  const [dietary, setDietary] = useState<string[]>([]);

  const toggleDietary = (tag: string) =>
    setDietary((d) =>
      d.includes(tag) ? d.filter((x) => x !== tag) : [...d, tag],
    );

  const handleSignOut = () => {
    Alert.alert("Sign out", "Sign out of FreshPlate?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          try {
            await signOut();
          } catch (err) {
            Toast.show({
              type: "error",
              text1: "Sign out failed",
              text2: err instanceof Error ? err.message : "Try again.",
            });
          }
        },
      },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingBottom: tabBarHeight + 32,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.display,
          fontSize: 28,
          letterSpacing: -0.6,
          color: colors.text,
          paddingHorizontal: 20,
          marginBottom: 18,
        }}
      >
        Profile
      </Text>

      <View
        style={{
          marginHorizontal: 16,
          backgroundColor: colors.surface,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: colors.border,
          padding: 18,
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
        }}
      >
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              fontFamily: fonts.display,
              fontSize: 26,
              color: colors.accentInk,
              letterSpacing: -0.5,
            }}
          >
            {(displayFirst ?? user?.email ?? "?").charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.display,
              fontSize: 20,
              letterSpacing: -0.4,
              color: colors.text,
            }}
          >
            {displayFull ?? "Set your name"}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.body,
              fontSize: 13,
              color: colors.textMuted,
              marginTop: 2,
            }}
          >
            {user?.email ?? ""}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push("/set-name")}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 100,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surfaceAlt,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 12,
              color: colors.textMuted,
            }}
          >
            Edit
          </Text>
        </Pressable>
      </View>

      <Section title="Taste profile" subtitle="Learned from what you've cooked">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {PLACEHOLDER_TASTE.map((t) => (
            <View
              key={t}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 100,
                backgroundColor: colors.accentSoft,
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  fontSize: 12,
                  color: colors.accent,
                  letterSpacing: -0.1,
                }}
              >
                {t}
              </Text>
            </View>
          ))}
        </View>
        <Text
          style={{
            marginTop: 10,
            fontFamily: fonts.body,
            fontSize: 11.5,
            color: colors.textSubtle,
          }}
        >
          Cook a few recipes to start seeing your real taste profile.
        </Text>
      </Section>

      <Section title="Dietary preferences">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {DIETARY_TAGS.map((t) => {
            const selected = dietary.includes(t);
            return (
              <Pressable
                key={t}
                onPress={() => toggleDietary(t)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 100,
                  backgroundColor: selected ? colors.accent : colors.surfaceAlt,
                }}
              >
                <Text
                  style={{
                    fontFamily: fonts.bodyStrong,
                    fontSize: 12.5,
                    color: selected ? colors.accentInk : colors.text,
                    letterSpacing: -0.1,
                  }}
                >
                  {t}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text
          style={{
            marginTop: 10,
            fontFamily: fonts.body,
            fontSize: 11.5,
            color: colors.textSubtle,
          }}
        >
          These won't be saved until preferences ship — placeholder for now.
        </Text>
      </Section>

      <Section title="Household">
        <Row
          icon="users"
          label="My household"
          value="1 member"
          onPress={() =>
            Toast.show({
              type: "info",
              text1: "Household management",
              text2: "Coming in Phase 9.",
            })
          }
        />
      </Section>

      <Section title="App" subtitle="Notifications ship in Phase 12 — toggle saved locally for now">
        <Row
          icon="bell"
          label="Expiration alerts"
          right={
            <Switch
              value={expirationAlerts}
              onValueChange={setExpirationAlerts}
              trackColor={{ false: colors.surfaceAlt, true: colors.accent }}
              thumbColor={colors.surface}
            />
          }
        />
        <Row
          icon="moon-o"
          label="Appearance"
          value="System"
          onPress={() =>
            Toast.show({
              type: "info",
              text1: "Appearance",
              text2: "Follows your device theme.",
            })
          }
        />
        <Row icon="sign-out" label="Sign out" tone="crit" onPress={handleSignOut} />
      </Section>

      <Text
        style={{
          textAlign: "center",
          fontFamily: fonts.body,
          fontSize: 11,
          color: colors.textSubtle,
          marginTop: 18,
        }}
      >
        FreshPlate · v0.1
      </Text>
    </ScrollView>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
      <View style={{ paddingHorizontal: 4, marginBottom: 10 }}>
        <Text
          style={{
            fontFamily: fonts.bodyStrong,
            fontSize: 11,
            color: colors.textMuted,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: 12,
              color: colors.textSubtle,
              marginTop: 3,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.border,
          padding: 14,
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Row({
  icon,
  label,
  value,
  right,
  onPress,
  tone,
}: {
  icon: React.ComponentProps<typeof FontAwesome>["name"];
  label: string;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  tone?: "crit";
}) {
  const { colors, fonts } = useTheme();
  const labelColor = tone === "crit" ? colors.crit : colors.text;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        opacity: pressed && onPress ? 0.6 : 1,
      })}
    >
      <FontAwesome name={icon} size={16} color={labelColor} />
      <Text
        style={{
          flex: 1,
          fontFamily: fonts.body,
          fontSize: 14.5,
          color: labelColor,
        }}
      >
        {label}
      </Text>
      {value ? (
        <Text
          style={{
            fontFamily: fonts.body,
            fontSize: 13,
            color: colors.textMuted,
          }}
        >
          {value}
        </Text>
      ) : null}
      {right}
      {onPress && !right ? (
        <FontAwesome name="angle-right" size={14} color={colors.textSubtle} />
      ) : null}
    </Pressable>
  );
}
