import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import {
  LayoutAnimationConfig,
  useReducedMotion,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";
import { useInventoryItems } from "@/hooks/useInventoryItems";
import { useInventoryView } from "@/hooks/useInventoryView";
import { useListMotion } from "@/hooks/useListMotion";
import InventoryViewControls from "@/components/InventoryViewControls";
import InventorySectionHeader from "@/components/InventorySectionHeader";
import InventoryListRow from "@/components/InventoryListRow";
import PinnedSectionList from "@/components/PinnedSectionList";
import { useSeenKeys } from "@/hooks/useSeenKeys";
import LoadingState from "@/components/LoadingState";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import {
  GROUP_BYS,
  type FoodRow,
  type FoodSection,
  type GroupBy,
  groupFoodRows,
  stackLots,
} from "@/lib/foodRows";
import { sortSections, type SortBy } from "@/lib/foodSort";
import {
  countActiveFilters,
  EMPTY_FILTERS,
  filterInventory,
  filterOptions,
  type InventoryFilters,
} from "@/lib/inventoryFilters";
import { ListChange } from "@/lib/listMotion";

const INITIAL_CELLS = 12;
// Screens of rows kept mounted around the visible one, counting it. Fewer
// screens mount fewer rows when the grouping changes, but more often during
// a fast scroll.
const WINDOW_SCREENS = 11;

type ListSection = {
  key: string;
  /** The rows the list shows, which are none while the section is closed. */
  data: readonly FoodRow[];
  fullSection: FoodSection;
  open: boolean;
};

const NO_ROWS: readonly FoodRow[] = [];

export default function InventoryScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const reducedMotion = useReducedMotion();
  const inventory = useInventoryItems();
  const view = useInventoryView();
  const { groupBy, sortBy } = view;

  /* The `added` query param pulses the matching row once per navigation, then
   * clears so subsequent re-renders don't replay the animation. */
  const { added } = useLocalSearchParams<{ added?: string }>();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const seenRows = useSeenKeys<FoodRow>((row) => row.foodId);
  useEffect(() => {
    if (!added) return;
    setHighlightId(added);
    router.setParams({ added: undefined });
    const t = setTimeout(() => setHighlightId(null), 1800);
    return () => clearTimeout(t);
  }, [added, router]);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    expired: true,
    today: true,
    week: true,
    fresh: false,
  });

  const { motion, animate, slideToward } = useListMotion(reducedMotion);

  const items = useMemo(() => inventory.data ?? [], [inventory.data]);
  const options = useMemo(() => filterOptions(items), [items]);
  const sections = useMemo(
    () =>
      sortSections(
        groupFoodRows(filterInventory(items, deferredQuery, filters), groupBy),
        sortBy,
      ),
    [items, deferredQuery, filters, groupBy, sortBy],
  );
  const listSections = useMemo<ListSection[]>(
    () =>
      sections
        .filter((section) => section.data.length > 0)
        .map((section) => {
          const open = openGroups[section.key] !== false;
          return {
            key: keyPerGrouping(groupBy, section.key),
            data: open ? section.data : NO_ROWS,
            fullSection: section,
            open,
          };
        }),
    [sections, openGroups, groupBy],
  );

  const chooseGroup = (next: GroupBy) => {
    slideToward(GROUP_BYS.indexOf(groupBy), GROUP_BYS.indexOf(next));
    view.setGroupBy(next);
  };
  const chooseSort = (next: SortBy) => {
    animate(ListChange.reorder);
    view.setSortBy(next);
  };
  const changeFilters = (
    update: (current: InventoryFilters) => InventoryFilters,
  ) => {
    animate(ListChange.reorder);
    setFilters(update);
  };
  const toggleSection = useCallback(
    (key: string) => {
      animate(ListChange.collapse);
      setOpenGroups((g) => ({ ...g, [key]: !(g[key] !== false) }));
    },
    [animate],
  );

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

  const activeFilterCount = countActiveFilters(filters);
  const allRows = useMemo(() => stackLots(items), [items]);
  const expiredCount = allRows.filter((r) => r.expiredLots > 0).length;
  const openReview = useCallback(() => router.push("/review-expired"), [router]);
  const openFood = useCallback(
    (row: FoodRow) => router.push(`/food/${row.foodId}`),
    [router],
  );
  const { seen } = seenRows;
  const renderRow = useCallback(
    ({ item: row, index }: { item: FoodRow; index: number }) => (
      <InventoryListRow
        row={row}
        highlight={highlightId !== null && holdsLot(row, highlightId)}
        photoEnabled={seen.has(row.foodId)}
        onPress={openFood}
        entering={motion.rowEntering(index)}
        exiting={motion.rowExiting}
      />
    ),
    [highlightId, seen, openFood, motion],
  );
  const renderSectionHeader = useCallback(
    ({ section }: { section: ListSection }) => (
      <InventorySectionHeader
        section={section.fullSection}
        open={section.open}
        onToggle={toggleSection}
        onReview={
          groupBy === "Urgency" && section.fullSection.key === "expired"
            ? openReview
            : undefined
        }
        entering={motion.rowEntering(0)}
        exiting={motion.rowExiting}
      />
    ),
    [toggleSection, groupBy, openReview, motion],
  );

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

  if (items.length === 0) {
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
    <View
      style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}
    >
      <LayoutAnimationConfig skipEntering>
        <PinnedSectionList
          sections={listSections}
          keyExtractor={(row) => keyPerGrouping(groupBy, row.key)}
          renderItem={renderRow}
          renderSectionHeader={renderSectionHeader}
          pinned={
            <InventoryViewControls
              groupBy={groupBy}
              onGroupByChange={chooseGroup}
              sortBy={sortBy}
              onSortChange={chooseSort}
              filters={filters}
              onFiltersChange={changeFilters}
              options={options}
              totalCount={allRows.length}
            />
          }
          layout={motion.layout}
          {...seenRows.listProps}
          initialNumToRender={INITIAL_CELLS}
          windowSize={WINDOW_SCREENS}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
            contentContainerStyle={{ paddingBottom: tabBarHeight + 24 }}
            refreshControl={
              <RefreshControl
                refreshing={inventory.isFetching && !inventory.isPending}
                onRefresh={() => inventory.refetch()}
                tintColor={colors.accent}
              />
            }
            ListHeaderComponent={
              <View
                style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}
              >
                <TopBar
                  title="Inventory"
                  subtitle={
                    <>
                      {`${allRows.length} item${allRows.length === 1 ? "" : "s"} · `}
                      <Text
                        style={
                          expiredCount > 0 ? { color: colors.crit } : undefined
                        }
                      >
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
                <SearchField initialValue={query} onChange={setQuery} />
              </View>
            }
            ListFooterComponent={
              listSections.length === 0 ? (
                <NoMatches
                  onClear={
                    activeFilterCount > 0
                      ? () => changeFilters(() => EMPTY_FILTERS)
                      : undefined
                  }
                />
              ) : null
            }
          />
      </LayoutAnimationConfig>
    </View>
  );
}

/**
 * The search bar. It leaves its text uncontrolled because a `value` prop forces
 * the native text to match it, so a slow list render would write a stale value
 * back over fast typing. `initialValue` restores the search when the field
 * remounts, such as after an error screen.
 */
function SearchField({
  initialValue,
  onChange,
}: {
  initialValue: string;
  onChange: (text: string) => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: 12,
        height: 44,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: colors.surfaceAlt,
      }}
    >
      <FontAwesome name="search" size={14} color={colors.textMuted} />
      <TextInput
        defaultValue={initialValue}
        onChangeText={onChange}
        placeholder="Search your fridge"
        placeholderTextColor={colors.textSubtle}
        accessibilityLabel="Search your fridge"
        returnKeyType="search"
        clearButtonMode="while-editing"
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          flex: 1,
          height: "100%",
          fontFamily: fonts.body,
          fontSize: 14,
          color: colors.text,
        }}
      />
    </View>
  );
}

function NoMatches({ onClear }: { onClear?: () => void }) {
  const { colors, fonts } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "center",
        gap: 4,
        paddingVertical: 48,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 13,
          color: colors.textMuted,
        }}
      >
        {onClear ? "No matches." : "No matches. Tap + to add one."}
      </Text>
      {onClear ? (
        <Pressable onPress={onClear} hitSlop={12} accessibilityRole="button">
          <Text
            style={{
              fontFamily: fonts.bodyStrong,
              fontSize: 13,
              color: colors.accent,
            }}
          >
            Clear filters
          </Text>
        </Pressable>
      ) : null}
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

function keyPerGrouping(groupBy: GroupBy, key: string): string {
  return `${groupBy}:${key}`;
}

function holdsLot(row: FoodRow, lotId: string): boolean {
  return row.lots.some((lot) => lot.id === lotId);
}
