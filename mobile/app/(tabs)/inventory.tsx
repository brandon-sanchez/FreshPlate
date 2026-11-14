import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useTheme } from "@/hooks/useTheme";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { daysUntilExpiration } from "@/lib/expiry";
import { useFoodCategories } from "@/hooks/useFoodCategories";
import SegmentedControl from "@/components/SegmentedControl";
import InventoryRow from "@/components/InventoryRow";
import LotOutcomeSwipe from "@/components/LotOutcomeSwipe";
import LoadingState from "@/components/LoadingState";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import FilterSheet, {
  countActiveFilters,
  EMPTY_FILTERS,
  InventoryFilters,
} from "@/components/FilterSheet";
import {
  type FoodRow,
  type FoodSection,
  type GroupBy,
  expiredLots,
  groupFoodRows,
  stackLots,
} from "@/lib/foodRows";

const GROUP_BY_OPTIONS: GroupBy[] = ["Urgency", "Location", "Category"];

export default function InventoryScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const inventory = useInventoryItems();
  const categoriesQuery = useFoodCategories();

  /* The `added` query param pulses the matching row once per navigation, then
   * clears so subsequent re-renders don't replay the animation. */
  const { added } = useLocalSearchParams<{ added?: string }>();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!added) return;
    setHighlightId(added);
    router.setParams({ added: undefined });
    const t = setTimeout(() => setHighlightId(null), 1800);
    return () => clearTimeout(t);
  }, [added, router]);

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

  const items = useMemo(() => inventory.data ?? [], [inventory.data]);
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

  const sections = useMemo(() => groupFoodRows(filtered, groupBy), [filtered, groupBy]);

  /* Auto-open the collapsible section containing the highlighted row so the
   * pulse animation isn't hidden behind a closed group. */
  useEffect(() => {
    if (!highlightId) return;
    for (const s of sections) {
      if (s.data.some((row) => holdsLot(row, highlightId))) {
        if (openGroups[s.key] === false) {
          setOpenGroups((g) => ({ ...g, [s.key]: true }));
        }
        return;
      }
    }
  }, [highlightId, sections, openGroups]);

  const visibleSections: FoodSection[] = sections
    .filter((s) => s.data.length > 0)
    .map((s) => ({ ...s, data: openGroups[s.key] === false ? [] : s.data }));

  const activeFilterCount = countActiveFilters(filters);
  const allRows = useMemo(() => stackLots(items), [items]);
  const expiredCount = allRows.filter((r) => r.expiredLots > 0).length;
  const expiredLotCount = useMemo(() => expiredLots(items).length, [items]);

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
    // The top inset pads the container rather than the list so sticky section
    // headers pin below the status bar.
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <SectionList<FoodRow, FoodSection>
        sections={visibleSections}
        keyExtractor={(row) => row.key}
        stickySectionHeadersEnabled
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
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
              subtitle={`${allRows.length} item${allRows.length === 1 ? "" : "s"} · ${expiredCount} expired`}
              colors={colors}
              fonts={fonts}
              padded={false}
              action={
                expiredLotCount > 0 ? (
                  <ReviewExpiredButton
                    expiredBatchCount={expiredLotCount}
                    onPress={() => router.push("/review-expired")}
                  />
                ) : null
              }
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
        renderSectionHeader={({ section: s }) => {
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
                backgroundColor: colors.bg,
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
        renderItem={({ item: row }) => (
          <LotOutcomeSwipe lotIds={row.countedLots.map((lot) => lot.id)} name={row.name}>
            <InventoryRow
              row={row}
              highlight={highlightId !== null && holdsLot(row, highlightId)}
              onPress={() => router.push(`/food/${row.foodId}`)}
            />
          </LotOutcomeSwipe>
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
  action,
}: {
  title: string;
  subtitle?: string;
  colors: ReturnType<typeof useTheme>["colors"];
  fonts: ReturnType<typeof useTheme>["fonts"];
  padded?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: padded ? 16 : 0,
        paddingTop: padded ? 12 : 0,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
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
      {action}
    </View>
  );
}

function ReviewExpiredButton({
  expiredBatchCount,
  onPress,
}: {
  expiredBatchCount: number;
  onPress: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`Review ${expiredBatchCount} expired batch${expiredBatchCount === 1 ? "" : "es"}`}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 100,
        borderWidth: 1,
        borderColor: colors.crit,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 12.5, color: colors.crit, letterSpacing: -0.1 }}>
        Review expired
      </Text>
    </Pressable>
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

function holdsLot(row: FoodRow, lotId: string): boolean {
  return row.lots.some((lot) => lot.id === lotId);
}
