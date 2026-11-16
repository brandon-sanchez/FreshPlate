import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  TextInput,
  View,
  type CellRendererProps,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Animated, { Easing, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { useInventoryView } from "@/hooks/useInventoryView";
import { daysUntilExpiration } from "@/lib/expiry";
import { useFoodCategories } from "@/hooks/useFoodCategories";
import InventoryViewControls from "@/components/InventoryViewControls";
import InventoryRow from "@/components/InventoryRow";
import LotOutcomeSwipe from "@/components/LotOutcomeSwipe";
import SortSheet from "@/components/SortSheet";
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
  groupFoodRows,
  stackLots,
} from "@/lib/foodRows";
import { sortSections, type SortBy } from "@/lib/foodSort";

const RESORT_WINDOW_MS = 400;

const resortTransition = LinearTransition.duration(260)
  .easing(Easing.out(Easing.cubic))
  .reduceMotion(ReduceMotion.System);

const ResortingContext = createContext(false);

/**
 * Wraps each list cell so a re-sort slides rows to their new places instead
 * of jumping. It animates the cell rather than the row inside it, because the
 * list moves whole cells when keys reorder. The transition is on only while
 * a re-sort settles, so collapsing a section or typing a search does not
 * slide rows away from their headers.
 */
function MovingCell({ onLayout, style, children }: CellRendererProps<FoodRow>) {
  const resorting = useContext(ResortingContext);
  return (
    <Animated.View
      layout={resorting ? resortTransition : undefined}
      onLayout={onLayout}
      style={style}
    >
      {children}
    </Animated.View>
  );
}

export default function InventoryScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const inventory = useInventoryItems();
  const categoriesQuery = useFoodCategories();
  const view = useInventoryView();
  const { groupBy, sortBy } = view;

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

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [resorting, setResorting] = useState(false);
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

  const sections = useMemo(
    () => sortSections(groupFoodRows(filtered, groupBy), sortBy),
    [filtered, groupBy, sortBy],
  );

  // The cells take the transition one frame before the rows move, because a
  // layout animation set in the same commit as the move does not run.
  const chooseSort = (next: SortBy) => {
    setResorting(true);
    requestAnimationFrame(() => view.setSortBy(next));
  };
  useEffect(() => {
    if (!resorting) return;
    const t = setTimeout(() => setResorting(false), RESORT_WINDOW_MS);
    return () => clearTimeout(t);
  }, [resorting, sortBy]);

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
  const openReview = () => router.push("/review-expired");

  if (inventory.isPending || !view.hydrated) {
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
      <ResortingContext.Provider value={resorting}>
        <SectionList<FoodRow, FoodSection>
          sections={visibleSections}
          keyExtractor={(row) => row.key}
          CellRendererComponent={MovingCell}
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
                subtitle={
                  <>
                    {`${allRows.length} item${allRows.length === 1 ? "" : "s"} · `}
                    <Text style={expiredCount > 0 ? { color: colors.crit } : undefined}>
                      {`${expiredCount} expired`}
                    </Text>
                  </>
                }
                onSubtitlePress={expiredCount > 0 ? openReview : undefined}
                subtitleLabel={`${expiredCount} expired. Review expired batches`}
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

              <InventoryViewControls
                groupBy={groupBy}
                onGroupByChange={view.setGroupBy}
                sortBy={sortBy}
                onSortPress={() => setSortSheetOpen(true)}
              />
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
                {groupBy === "Urgency" && s.key === "expired" ? (
                  <Pressable
                    onPress={openReview}
                    hitSlop={12}
                    accessibilityRole="link"
                    accessibilityLabel="Review expired batches"
                    style={({ pressed }) => ({ marginLeft: "auto", opacity: pressed ? 0.6 : 1 })}
                  >
                    <Text style={{ fontFamily: fonts.bodyStrong, fontSize: 12, color: colors.accent }}>
                      Review
                    </Text>
                  </Pressable>
                ) : null}
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
      </ResortingContext.Provider>

      <SortSheet
        visible={sortSheetOpen}
        selected={sortBy}
        onSelect={chooseSort}
        onClose={() => setSortSheetOpen(false)}
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
  onSubtitlePress,
  subtitleLabel,
  colors,
  fonts,
  padded = true,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** Makes the subtitle a link, with a chevron after it. */
  onSubtitlePress?: () => void;
  /** The subtitle link's screen-reader label. */
  subtitleLabel?: string;
  colors: ReturnType<typeof useTheme>["colors"];
  fonts: ReturnType<typeof useTheme>["fonts"];
  padded?: boolean;
}) {
  const subtitleText = subtitle ? (
    <Text
      style={{
        fontFamily: fonts.body,
        fontSize: 13,
        color: colors.textMuted,
      }}
    >
      {subtitle}
    </Text>
  ) : null;
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
      {subtitleText && onSubtitlePress ? (
        <Pressable
          onPress={onSubtitlePress}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityRole="link"
          accessibilityLabel={subtitleLabel}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            alignSelf: "flex-start",
            gap: 5,
            marginTop: 2,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {subtitleText}
          <FontAwesome name="angle-right" size={13} color={colors.crit} />
        </Pressable>
      ) : subtitleText ? (
        <View style={{ marginTop: 2 }}>{subtitleText}</View>
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

function holdsLot(row: FoodRow, lotId: string): boolean {
  return row.lots.some((lot) => lot.id === lotId);
}
