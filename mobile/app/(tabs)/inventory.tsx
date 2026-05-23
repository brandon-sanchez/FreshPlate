import { useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import {
  daysUntilExpiration,
  InventoryItem,
  useInventoryItems,
} from "@/hooks/useInventoryItems";
import { useFoodCategories } from "@/hooks/useFoodCategories";
import SegmentedControl from "@/components/SegmentedControl";
import InventoryRow from "@/components/InventoryRow";
import LoadingState from "@/components/LoadingState";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import FilterSheet, {
  countActiveFilters,
  EMPTY_FILTERS,
  InventoryFilters,
} from "@/components/FilterSheet";

type GroupBy = "Urgency" | "Location" | "Category";
type Section = { key: string; label: string; tone?: "crit" | "warn"; data: InventoryItem[] };

const GROUP_BY_OPTIONS: GroupBy[] = ["Urgency", "Location", "Category"];

export default function InventoryScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const inventory = useInventoryItems();
  const categoriesQuery = useFoodCategories();

  const [groupBy, setGroupBy] = useState<GroupBy>("Urgency");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    expired: true,
    today: true,
    week: true,
    fresh: false,
  });

  const items = inventory.data ?? [];
  const categories = categoriesQuery.data ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((i) => {
      if (needle && !i.name.toLowerCase().includes(needle)) return false;
      if (filters.locations.length && !filters.locations.includes(i.storage_location))
        return false;
      if (filters.categories.length && !filters.categories.includes(i.category?.id ?? ""))
        return false;
      if (filters.leftoversOnly && !i.is_leftover) return false;
      if (filters.expiringWeek) {
        const d = daysUntilExpiration(i.expiration_date);
        if (d === null || d > 6) return false;
      }
      return true;
    });
  }, [items, query, filters]);

  const sections: Section[] = useMemo(() => {
    if (groupBy === "Urgency") {
      const withDays = filtered.map((i) => ({
        item: i,
        days: daysUntilExpiration(i.expiration_date),
      }));
      const bucket = (test: (d: number | null) => boolean) =>
        withDays
          .filter((x) => test(x.days))
          .sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity))
          .map((x) => x.item);
      return [
        { key: "expired", label: "Expired", tone: "crit", data: bucket((d) => d !== null && d < 0) },
        {
          key: "today",
          label: "Use today or tomorrow",
          tone: "warn",
          data: bucket((d) => d !== null && d >= 0 && d <= 1),
        },
        { key: "week", label: "This week", data: bucket((d) => d !== null && d >= 2 && d <= 6) },
        { key: "fresh", label: "Fresh", data: bucket((d) => d === null || d > 6) },
      ];
    }
    if (groupBy === "Location") {
      const locs: InventoryItem["storage_location"][] = ["fridge", "freezer", "pantry"];
      return locs.map((loc) => ({
        key: loc,
        label: capitalize(loc),
        data: filtered.filter((i) => i.storage_location === loc),
      }));
    }
    const byCat = new Map<string, InventoryItem[]>();
    filtered.forEach((i) => {
      const key = i.category?.id ?? "uncategorized";
      const arr = byCat.get(key) ?? [];
      arr.push(i);
      byCat.set(key, arr);
    });
    return Array.from(byCat.entries()).map(([key, data]) => ({
      key,
      label: data[0]?.category?.name ?? "Uncategorized",
      data,
    }));
  }, [filtered, groupBy]);

  const visibleSections: Section[] = sections
    .filter((s) => s.data.length > 0)
    .map((s) => ({ ...s, data: openGroups[s.key] === false ? [] : s.data }));

  const activeFilterCount = countActiveFilters(filters);
  const expiredCount = items.filter((i) => {
    const d = daysUntilExpiration(i.expiration_date);
    return d !== null && d < 0;
  }).length;

  if (inventory.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <LoadingState label="Loading your fridge…" />
      </View>
    );
  }

  if (inventory.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorState onRetry={() => inventory.refetch()} />
      </View>
    );
  }

  const isEmpty = items.length === 0;

  if (isEmpty) {
    return (
      <View
        style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}
      >
        <TopBar
          title="Inventory"
          subtitle="Nothing here yet"
          colors={colors}
          fonts={fonts}
        />
        <EmptyState
          icon={
            <FontAwesome name="archive" size={36} color={colors.textSubtle} />
          }
          title="Your fridge is empty"
          message="Track what's in your fridge and pantry so you waste less and cook more."
          ctaLabel="Add your first item"
          onCtaPress={() => router.push("/(tabs)/add-item")}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SectionList
        sections={visibleSections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: insets.top + 8,
          paddingBottom: tabBarHeight + 24,
        }}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        SectionSeparatorComponent={null}
        refreshControl={
          <RefreshControl
            refreshing={inventory.isFetching && !inventory.isPending}
            onRefresh={() => inventory.refetch()}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          <View style={{ paddingTop: 4 }}>
            <TopBar
              title="Inventory"
              subtitle={`${items.length} item${items.length === 1 ? "" : "s"} · ${expiredCount} expired`}
              colors={colors}
              fonts={fonts}
              padded={false}
            />

            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <View
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  backgroundColor: colors.surfaceAlt,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  height: 44,
                }}
              >
                <FontAwesome name="search" size={14} color={colors.textMuted} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search your fridge"
                  placeholderTextColor={colors.textSubtle}
                  style={{
                    flex: 1,
                    fontFamily: fonts.body,
                    fontSize: 14,
                    color: colors.text,
                  }}
                />
              </View>
              <Pressable
                onPress={() => setFilterSheetOpen(true)}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  backgroundColor:
                    activeFilterCount > 0 ? colors.accent : colors.surfaceAlt,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FontAwesome
                  name="filter"
                  size={16}
                  color={
                    activeFilterCount > 0 ? colors.accentInk : colors.textMuted
                  }
                />
                {activeFilterCount > 0 ? (
                  <View
                    style={{
                      position: "absolute",
                      top: -4,
                      right: -4,
                      minWidth: 18,
                      height: 18,
                      borderRadius: 9,
                      backgroundColor: colors.crit,
                      paddingHorizontal: 5,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        color: "#fff",
                        fontSize: 10,
                        fontFamily: fonts.bodyStrong,
                      }}
                    >
                      {activeFilterCount}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            </View>

            {activeFilterCount > 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 10,
                }}
              >
                {filters.locations.map((l) => (
                  <ActiveChip
                    key={`loc-${l}`}
                    label={capitalize(l)}
                    onRemove={() =>
                      setFilters((f) => ({
                        ...f,
                        locations: f.locations.filter((x) => x !== l),
                      }))
                    }
                  />
                ))}
                {filters.categories.map((cid) => {
                  const cat = categories.find((c) => c.id === cid);
                  return (
                    <ActiveChip
                      key={`cat-${cid}`}
                      label={cat?.name ?? "Category"}
                      onRemove={() =>
                        setFilters((f) => ({
                          ...f,
                          categories: f.categories.filter((x) => x !== cid),
                        }))
                      }
                    />
                  );
                })}
                {filters.expiringWeek ? (
                  <ActiveChip
                    label="Expiring this week"
                    onRemove={() =>
                      setFilters((f) => ({ ...f, expiringWeek: false }))
                    }
                  />
                ) : null}
                {filters.leftoversOnly ? (
                  <ActiveChip
                    label="Leftovers only"
                    onRemove={() =>
                      setFilters((f) => ({ ...f, leftoversOnly: false }))
                    }
                  />
                ) : null}
                <Pressable onPress={() => setFilters(EMPTY_FILTERS)}>
                  <Text
                    style={{
                      fontFamily: fonts.body,
                      fontSize: 11.5,
                      color: colors.textMuted,
                      textDecorationLine: "underline",
                      paddingVertical: 6,
                      paddingHorizontal: 6,
                    }}
                  >
                    Clear all
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                marginTop: 14,
                marginBottom: 12,
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.body,
                  fontSize: 11,
                  color: colors.textSubtle,
                }}
              >
                Group by
              </Text>
              <View style={{ flex: 1 }}>
                <SegmentedControl
                  options={GROUP_BY_OPTIONS as unknown as string[]}
                  selected={groupBy}
                  onSelect={(v) => setGroupBy(v as GroupBy)}
                />
              </View>
            </View>
          </View>
        }
        renderSectionHeader={({ section }) => {
          const s = section as unknown as Section;
          const open = openGroups[s.key] !== false;
          const labelColor =
            s.tone === "crit"
              ? colors.crit
              : s.tone === "warn"
                ? colors.warn
                : colors.textMuted;
          return (
            <Pressable
              onPress={() =>
                setOpenGroups((g) => ({ ...g, [s.key]: !(g[s.key] !== false) }))
              }
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingTop: 14,
                paddingBottom: 8,
              }}
            >
              <FontAwesome
                name={open ? "angle-down" : "angle-right"}
                size={14}
                color={colors.textMuted}
              />
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  fontSize: 12,
                  color: labelColor,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                {s.label}
              </Text>
              <Text
                style={{
                  fontFamily: fonts.body,
                  fontSize: 11,
                  color: colors.textSubtle,
                }}
              >
                {sections.find((x) => x.key === s.key)?.data.length ?? 0}
              </Text>
            </Pressable>
          );
        }}
        renderItem={({ item }) => (
          <InventoryRow
            item={item}
            onPress={() => router.push(`/item/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <Text
              style={{
                fontFamily: fonts.body,
                fontSize: 13,
                color: colors.textMuted,
                textAlign: "center",
              }}
            >
              No matches.{" "}
              {activeFilterCount > 0
                ? "Try clearing some filters."
                : "Tap + to add one."}
            </Text>
          </View>
        }
      />

      <FilterSheet
        visible={filterSheetOpen}
        filters={filters}
        categories={categories}
        onApply={setFilters}
        onClose={() => setFilterSheetOpen(false)}
      />
    </View>
  );
}

function TopBar({
  title,
  subtitle,
  colors,
  fonts,
  padded = true,
}: {
  title: string;
  subtitle?: string;
  colors: ReturnType<typeof useTheme>["colors"];
  fonts: ReturnType<typeof useTheme>["fonts"];
  padded?: boolean;
}) {
  return (
    <View
      style={{
        paddingHorizontal: padded ? 16 : 0,
        paddingTop: padded ? 12 : 0,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.display,
          fontSize: 26,
          letterSpacing: -0.5,
          color: colors.text,
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          style={{
            fontFamily: fonts.body,
            fontSize: 13,
            color: colors.textMuted,
            marginTop: 2,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

function ActiveChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingLeft: 10,
        paddingRight: 5,
        paddingVertical: 5,
        borderRadius: 100,
        backgroundColor: colors.accentSoft,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 11.5,
          color: colors.accent,
          letterSpacing: -0.1,
        }}
      >
        {label}
      </Text>
      <Pressable
        onPress={onRemove}
        hitSlop={6}
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: "rgba(0,0,0,0.08)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FontAwesome name="times" size={9} color={colors.accent} />
      </Pressable>
    </View>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
