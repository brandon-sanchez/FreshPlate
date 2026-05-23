import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import { firstNameFromMetadata, useAuthStore } from "@/stores/auth";
import { useProfile, useUpdateProfile } from "@/hooks/useProfile";
import { useTheme } from "@/hooks/useTheme";

export default function SetNameScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const profile = useProfile();
  const updateProfile = useUpdateProfile();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const existing = profile.data?.display_name?.trim();
    if (existing) {
      const parts = existing.split(/\s+/);
      setFirstName(parts[0] ?? "");
      setLastName(parts.slice(1).join(" "));
      setHydrated(true);
      return;
    }
    const fromOAuth = firstNameFromMetadata(user);
    if (fromOAuth) {
      setFirstName(fromOAuth);
      setHydrated(true);
    }
  }, [profile.data, user, hydrated]);

  const trimmedFirst = firstName.trim();
  const trimmedLast = lastName.trim();
  const canSave = trimmedFirst.length > 0 && !updateProfile.isPending;

  const handleSave = () => {
    if (!canSave) return;
    const displayName = [trimmedFirst, trimmedLast].filter(Boolean).join(" ");
    updateProfile.mutate(
      { display_name: displayName },
      {
        onSuccess: () => {
          Toast.show({ type: "success", text1: `Welcome, ${trimmedFirst}` });
          router.back();
        },
        onError: () =>
          Toast.show({
            type: "error",
            text1: "Couldn't save",
            text2: "Check your connection and try again.",
          }),
      },
    );
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        paddingTop: insets.top + 12,
      }}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 }}
      >
        <Text
          style={{
            fontFamily: fonts.display,
            fontSize: 28,
            letterSpacing: -0.6,
            color: colors.text,
          }}
        >
          What should we call you?
        </Text>
        <Text
          style={{
            fontFamily: fonts.body,
            fontSize: 14,
            color: colors.textMuted,
            marginTop: 6,
            lineHeight: 20,
          }}
        >
          This is the name we'll use on your home screen and in your household.
        </Text>
      </View>

      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        <FieldRow
          label="First name"
          value={firstName}
          onChangeText={setFirstName}
          placeholder="Brandon"
          autoCapitalize="words"
        />
        <FieldRow
          label="Last name (optional)"
          value={lastName}
          onChangeText={setLastName}
          placeholder="Sanchez"
          autoCapitalize="words"
        />
      </View>

      <View style={{ flex: 1 }} />

      <View
        style={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 16,
          paddingTop: 12,
          gap: 10,
        }}
      >
        <Pressable
          onPress={handleSave}
          disabled={!canSave}
          style={{
            height: 52,
            borderRadius: 14,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity: canSave ? 1 : 0.5,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 15,
              color: colors.accentInk,
              letterSpacing: -0.2,
            }}
          >
            {updateProfile.isPending ? "Saving…" : "Save"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => router.back()}
          style={{
            height: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: 13,
              color: colors.textMuted,
            }}
          >
            Not now
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function FieldRow({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  const { colors, fonts } = useTheme();
  return (
    <View>
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 11,
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          marginBottom: 8,
        }}
      >
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSubtle}
        autoCapitalize={autoCapitalize}
        style={{
          height: 52,
          paddingHorizontal: 14,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          color: colors.text,
          fontFamily: fonts.body,
          fontSize: 16,
        }}
      />
    </View>
  );
}
