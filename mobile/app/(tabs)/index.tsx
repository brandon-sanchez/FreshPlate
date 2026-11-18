import ActiveCookBanner from "@/components/active-cook-banner";
import { useMemo, useState } from "react";
import type { QueryStatus } from "@tanstack/react-query";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import { firstNameFromMetadata, useAuthStore } from "@/stores/auth";
import { firstNameFromProfile, useProfile } from "@/hooks/useProfile";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { stackLots } from "@/lib/foodRows";
import InventoryRow from "@/components/InventoryRow";
import HomeListSkeleton from "@/components/home-list-skeleton";
import { SkeletonBar, SkeletonPulse } from "@/components/skeleton";
import ErrorState from "@/components/ErrorState";
import EmptyState from "@/components/EmptyState";

const PROMPT_SUGGESTIONS = [
  "Something quick with chicken",
  "Use what's expiring",
  "Low effort dinner",
] as const;

const NAME_LINE_HEIGHT = 36;
const STAT_VALUE_LINE_HEIGHT = 30;

export default function HomeScreen() {
  const { colors, fonts, card } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const user = useAuthStore((s) => s.user);
  const profile = useProfile();
  const inventory = useInventoryItems();

  const [prompt, setPrompt] = useState("");

  const resolvedName =
    firstNameFromProfile(profile.data?.display_name) ??
    firstNameFromMetadata(user);
  const greeting = greetingFor(new Date().getHours());

  const rows = useMemo(() => stackLots(inventory.data ?? []), [inventory.data]);
  const expired = rows.filter((r) => r.expiredLots > 0);
  const useSoon = rows.filter(
    (r) => r.expiredLots === 0 && r.days !== null && r.days >= 0 && r.days <= 2,
  );
  const useThisWeekCount = rows.filter(
    (r) => r.urgency === "today" || r.urgency === "week",
  ).length;

  const handleSubmitPrompt = () => {
    if (!prompt.trim()) return;
    router.push("/(tabs)/recipes");
  };

  const handleAskMeInstead = () => {
    router.push("/(tabs)/recipes");
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: tabBarHeight + 24,
      }}
    >
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: 4,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: 12,
              color: colors.textMuted,
            }}
          >
            Good {greeting},
          </Text>
          <NameLine
            name={resolvedName}
            status={profile.status}
            onSetName={() => router.push("/set-name")}
          />
        </View>
        <Pressable
          onPress={() => router.push("/(tabs)/profile")}
          style={{
            width: 38,
            height: 38,
            borderRadius: 100,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surfaceAlt,
            alignItems: "center",
            justifyContent: "center",
            marginTop: 6,
          }}
        >
          <FontAwesome name="bell" size={15} color={colors.textMuted} />
        </Pressable>
      </View>

      <ActiveCookBanner style={{ marginHorizontal: 16, marginTop: 18 }} />

      <View style={{ paddingHorizontal: 16, paddingTop: 18 }}>
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: 22,
            padding: 18,
            borderWidth: 1,
            borderColor: colors.border,
            shadowColor: card.shadowColor,
            shadowOffset: card.shadowOffset,
            shadowOpacity: card.shadowOpacity,
            shadowRadius: card.shadowRadius,
            elevation: card.elevation,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FontAwesome name="magic" size={14} color={colors.accentInk} />
            </View>
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 13,
                color: colors.text,
                letterSpacing: -0.1,
              }}
            >
              What do you want to cook?
            </Text>
          </View>

          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Tell me what you're in the mood for…"
            placeholderTextColor={colors.textSubtle}
            multiline
            style={{
              fontFamily: fonts.body,
              fontSize: 15,
              color: colors.text,
              minHeight: 48,
              padding: 0,
              textAlignVertical: "top",
              letterSpacing: -0.1,
            }}
          />

          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 10,
            }}
          >
            <Pressable
              onPress={handleAskMeInstead}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                backgroundColor: colors.surfaceAlt,
                borderRadius: 100,
                paddingHorizontal: 12,
                paddingVertical: 7,
              }}
            >
              <FontAwesome name="list" size={11} color={colors.textMuted} />
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  fontSize: 12,
                  color: colors.textMuted,
                }}
              >
                Ask me instead
              </Text>
            </Pressable>
            <Pressable
              onPress={handleSubmitPrompt}
              disabled={!prompt.trim()}
              style={{
                width: 34,
                height: 34,
                borderRadius: 100,
                backgroundColor: prompt.trim()
                  ? colors.accent
                  : colors.surfaceAlt,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FontAwesome
                name="arrow-up"
                size={14}
                color={prompt.trim() ? colors.accentInk : colors.textSubtle}
              />
            </Pressable>
          </View>
        </View>

        <View
          style={{
            flexDirection: "row",
            gap: 6,
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          {PROMPT_SUGGESTIONS.map((p) => (
            <Pressable
              key={p}
              onPress={() => setPrompt(p)}
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 100,
                paddingHorizontal: 12,
                paddingVertical: 6,
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.body,
                  fontSize: 12,
                  color: colors.textMuted,
                }}
              >
                {p}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
        <StatRow
          status={inventory.status}
          foodCount={rows.length}
          useThisWeekCount={useThisWeekCount}
          expiredCount={expired.length}
          onPress={() => router.push("/(tabs)/inventory")}
          onExpiredPress={() => router.push("/review-expired")}
        />
      </View>

      {inventory.isPending ? (
        <HomeListSkeleton />
      ) : inventory.isError ? (
        <ErrorState onRetry={() => inventory.refetch()} />
      ) : expired.length === 0 && useSoon.length === 0 ? (
        <View style={{ paddingTop: 12 }}>
          <EmptyState
            icon={
              <FontAwesome
                name="check-circle"
                size={36}
                color={colors.ok}
              />
            }
            title="Your fridge is in good shape"
            message="Nothing expiring soon. Add items as you shop to keep track."
          />
        </View>
      ) : (
        <>
          {expired.length > 0 ? (
            <Section
              title="Expired"
              tone="crit"
              count={expired.length}
              onSeeAll={() => router.push("/review-expired")}
            >
              {expired.slice(0, 3).map((row) => (
                <InventoryRow
                  key={row.key}
                  row={row}
                  photoEnabled
                  onPress={() => router.push(`/food/${row.foodId}`)}
                />
              ))}
            </Section>
          ) : null}

          {useSoon.length > 0 ? (
            <Section
              title="Use soon"
              count={useSoon.length}
              onSeeAll={() => router.push("/(tabs)/inventory")}
            >
              {useSoon.slice(0, 3).map((row) => (
                <InventoryRow
                  key={row.key}
                  row={row}
                  photoEnabled
                  onPress={() => router.push(`/food/${row.foodId}`)}
                />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function Section({
  title,
  count,
  tone,
  onSeeAll,
  children,
}: {
  title: string;
  count: number;
  tone?: "crit";
  onSeeAll?: () => void;
  children: React.ReactNode;
}) {
  const { colors, fonts } = useTheme();
  const labelColor = tone === "crit" ? colors.crit : colors.textMuted;
  return (
    <View style={{ paddingTop: 24 }}>
      <View
        style={{
          paddingHorizontal: 20,
          paddingBottom: 10,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 12,
              color: labelColor,
              textTransform: "uppercase",
              letterSpacing: 1.2,
            }}
          >
            {title}
          </Text>
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: 11,
              color: colors.textSubtle,
            }}
          >
            {count}
          </Text>
        </View>
        {onSeeAll ? (
          <Pressable onPress={onSeeAll} hitSlop={6}>
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 12,
                color: colors.textMuted,
              }}
            >
              See all
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View
        style={{
          paddingHorizontal: 16,
          flexDirection: "column",
          gap: 6,
        }}
      >
        {children}
      </View>
    </View>
  );
}

function StatRow({
  status,
  foodCount,
  useThisWeekCount,
  expiredCount,
  onPress,
  onExpiredPress,
}: {
  status: QueryStatus;
  foodCount: number;
  useThisWeekCount: number;
  expiredCount: number;
  onPress: () => void;
  onExpiredPress: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <StatTile
        label="In kitchen"
        accessibilityLabelFor={(n) => `${n} ${n === 1 ? "food" : "foods"} in your kitchen`}
        value={foodCount}
        status={status}
        onPress={onPress}
        colors={colors}
        fonts={fonts}
      />
      <StatTile
        label="Use this week"
        accessibilityLabelFor={(n) => `${n} to use this week`}
        value={useThisWeekCount}
        status={status}
        accent
        onPress={onPress}
        colors={colors}
        fonts={fonts}
      />
      <StatTile
        label="Expired"
        accessibilityLabelFor={(n) => `${n} expired`}
        value={expiredCount}
        status={status}
        warn={expiredCount > 0}
        onPress={onExpiredPress}
        colors={colors}
        fonts={fonts}
      />
    </View>
  );
}

function StatTile({
  label,
  accessibilityLabelFor,
  value,
  status,
  accent,
  warn,
  onPress,
  colors,
  fonts,
}: {
  label: string;
  accessibilityLabelFor: (count: number) => string;
  value: number;
  status: QueryStatus;
  accent?: boolean;
  warn?: boolean;
  onPress: () => void;
  colors: ReturnType<typeof useTheme>["colors"];
  fonts: ReturnType<typeof useTheme>["fonts"];
}) {
  const valueColor = warn ? colors.crit : accent ? colors.accent : colors.text;
  const borderColor = warn ? colors.crit : colors.border;
  const spokenLabel = {
    pending: `${label}, loading`,
    error: `${label}, unavailable`,
    success: accessibilityLabelFor(value),
  }[status];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={spokenLabel}
      accessibilityState={{ busy: status === "pending" }}
      style={{
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 14,
        borderRadius: 14,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor,
      }}
    >
      {status === "pending" ? (
        <SkeletonPulse style={{ height: STAT_VALUE_LINE_HEIGHT, justifyContent: "center" }}>
          <SkeletonBar width={34} height={22} />
        </SkeletonPulse>
      ) : (
        <Text
          style={{
            fontFamily: fonts.display,
            fontSize: 26,
            lineHeight: STAT_VALUE_LINE_HEIGHT,
            letterSpacing: -0.5,
            color: status === "error" ? colors.textSubtle : valueColor,
          }}
        >
          {status === "error" ? "–" : value}
        </Text>
      )}
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 11,
          color: colors.textMuted,
          marginTop: 4,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function NameLine({
  name,
  status,
  onSetName,
}: {
  name: string | null;
  status: QueryStatus;
  onSetName: () => void;
}) {
  const { colors, fonts } = useTheme();
  const nameStyle = {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: NAME_LINE_HEIGHT,
    letterSpacing: -0.7,
    marginTop: 2,
  };

  // Waits for the profile even when OAuth metadata already has a name,
  // because a name set in the app wins and would replace it a moment later.
  if (status === "pending") {
    return (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading your name"
        accessibilityState={{ busy: true }}
      >
        <SkeletonPulse style={{ height: NAME_LINE_HEIGHT, marginTop: 2, justifyContent: "center" }}>
          <SkeletonBar width={140} height={26} radius={8} />
        </SkeletonPulse>
      </View>
    );
  }
  if (name) {
    return <Text style={[nameStyle, { color: colors.text }]}>{name}</Text>;
  }
  // A failed load does not mean the name is unset, so offer no link.
  if (status === "error") {
    return <View style={{ height: NAME_LINE_HEIGHT, marginTop: 2 }} />;
  }
  return (
    <Pressable onPress={onSetName}>
      <Text style={[nameStyle, { color: colors.accent, textDecorationLine: "underline" }]}>
        Set your name
      </Text>
    </Pressable>
  );
}

function greetingFor(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}
