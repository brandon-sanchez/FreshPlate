import { ReactNode, Ref, useRef } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "@/lib/toast";
import { useAuthStore, firstNameFromMetadata } from "@/stores/auth";
import { useTheme } from "@/hooks/useTheme";
import { firstNameFromProfile, useProfile } from "@/hooks/useProfile";
import { useScrollAboveKeyboard } from "@/hooks/useScrollAboveKeyboard";
import KitchenBasicsEditor from "@/components/kitchen-basics-editor";

/**
 * Returns the email with its local part reduced to the first character, such
 * as `b•••@gmail.com`, so the address isn't shown in full on a shared screen.
 */
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * The Profile tab: the person's name, their kitchen basics, the app's
 * appearance setting and sign out.
 */
export default function ProfileScreen() {
  const { colors, fonts, spacing } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const profile = useProfile();
  const scrollRef = useRef<ScrollView>(null);
  const basicsCardRef = useRef<View>(null);
  const basicsKeyboard = useScrollAboveKeyboard(
    scrollRef,
    basicsCardRef,
    spacing.gap,
  );

  const displayFirst =
    firstNameFromProfile(profile.data?.display_name) ??
    firstNameFromMetadata(user);
  const displayFull = profile.data?.display_name?.trim() ?? displayFirst ?? null;

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
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingBottom: tabBarHeight + 32,
      }}
      // Insets the scroll view by the keyboard's height on iOS and scrolls the
      // focused field, such as "Add a basic", above the keyboard.
      automaticallyAdjustKeyboardInsets
      // Lets the Add button take the first tap while the keyboard is open.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
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
            {user?.email ? maskEmail(user.email) : ""}
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

      <Section
        title="Kitchen basics"
        subtitle="Recipes can always use these. Cooking never deducts them."
        cardRef={basicsCardRef}
        cardTestID="kitchen-basics-card"
      >
        <KitchenBasicsEditor
          onInputFocus={basicsKeyboard.onFocus}
          onInputBlur={basicsKeyboard.onBlur}
        />
      </Section>

      <Section title="App">
        <Row icon="moon-o" label="Appearance" value="Matches your device" />
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
  cardRef,
  cardTestID,
  children,
}: {
  title: string;
  subtitle?: string;
  cardRef?: Ref<View>;
  cardTestID?: string;
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
        ref={cardRef}
        testID={cardTestID}
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
  onPress,
  tone,
}: {
  icon: React.ComponentProps<typeof FontAwesome>["name"];
  label: string;
  value?: string;
  onPress?: () => void;
  tone?: "crit";
}) {
  const { colors, fonts } = useTheme();
  const labelColor = tone === "crit" ? colors.crit : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
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
      {onPress ? (
        <FontAwesome name="angle-right" size={14} color={colors.textSubtle} />
      ) : null}
    </Pressable>
  );
}
