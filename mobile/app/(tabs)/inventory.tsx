import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RefreshControl, ScrollView, View } from "react-native";
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
import { useRegroup } from "@/hooks/useRegroup";
import InventoryViewControls from "@/components/InventoryViewControls";
import InventorySectionHeader from "@/components/InventorySectionHeader";
import InventoryListRow from "@/components/InventoryListRow";
import PinnedSectionList, {
  type PinnedSectionListHandle,
} from "@/components/PinnedSectionList";
import {
  InventoryListHeader,
  NoMatches,
  TopBar,
} from "@/components/InventoryListHeader";
import { useSeenKeys } from "@/hooks/useSeenKeys";
import RecentlyUsedUp from "@/components/RecentlyUsedUp";
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
const WINDOW_SCREENS = 9;
const ROWS_PER_BATCH = 3;

type ListSection = {
  key: string;
  /** The rows the list shows, which are none while the section is closed. */
  data: readonly FoodRow[];
  fullSection: FoodSection;
  open: boolean;
};

const NO_ROWS: readonly FoodRow[] = [];

// The Recently used up amount field sits at the end of the content and its
// numeric keypad has no return key, so the list scrolls it above the keyboard
// and lets a tap reach the Restore button while the keyboard is up.
const KEYBOARD_SCROLL_PROPS = {
  automaticallyAdjustKeyboardInsets: true,
  keyboardShouldPersistTaps: "handled",
  keyboardDismissMode: "interactive",
} as const;

export default function InventoryScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const reducedMotion = useReducedMotion();
  const inventory = useInventoryItems();
  const view = useInventoryView();
  const { groupBy, sortBy, setGroupBy, setSortBy } = view;

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

  const { motion, animate, hide, show } = useListMotion(reducedMotion);
  const list = useRef<PinnedSectionListHandle>(null);
  // The new grouping starts at its top, under the pinned controls.
  const scrollToPinned = useCallback(() => list.current?.scrollToPinned(), []);
  const revealUsedUpFooter = useCallback(() => list.current?.scrollToEnd(), []);
  const emptyScroll = useRef<ScrollView>(null);
  const scrollEmptyToEnd = useCallback(
    () => emptyScroll.current?.scrollToEnd({ animated: true }),
    [],
  );
  const { rowCap, regroup } = useRegroup({
    hide,
    show,
    onHidden: scrollToPinned,
    fillTo: INITIAL_CELLS,
  });
  const [pendingGroup, setPendingGroup] = useState<GroupBy | null>(null);

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
  const previousSections = useRef(new Map<string, ListSection>());
  const listSections = useMemo(() => {
    const list = capRows(sections, openGroups, rowCap, previousSections.current);
    previousSections.current = new Map(list.map((section) => [section.key, section]));
    return list;
  }, [sections, openGroups, rowCap]);

  const chooseGroup = useCallback(
    (next: GroupBy) => {
      const shown = pendingGroup ?? groupBy;
      if (next === shown) return;
      setPendingGroup(next);
      regroup(GROUP_BYS.indexOf(shown), GROUP_BYS.indexOf(next), () => {
        setGroupBy(next);
        setPendingGroup(null);
      });
    },
    [pendingGroup, groupBy, regroup, setGroupBy],
  );
  const chooseSort = useCallback(
    (next: SortBy) => {
      animate(ListChange.reorder);
      setSortBy(next);
    },
    [animate, setSortBy],
  );
  const changeFilters = useCallback(
    (update: (current: InventoryFilters) => InventoryFilters) => {
      animate(ListChange.reorder);
      setFilters(update);
    },
    [animate],
  );
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
  const highlightRestored = useCallback(
    (lotId: string) => router.setParams({ added: lotId }),
    [router],
  );

  const listHeader = useMemo(
    () => (
      <InventoryListHeader
        itemCount={allRows.length}
        expiredCount={expiredCount}
        onReview={openReview}
        initialQuery={query}
        onQueryChange={setQuery}
      />
    ),
    [allRows.length, expiredCount, openReview, query],
  );
  const noMatches = sections.every((section) => section.data.length === 0);
  const canClear = activeFilterCount > 0;
  const listFooter = useMemo(
    () => (
      <>
        {noMatches ? (
          <NoMatches
            onClear={canClear ? () => changeFilters(() => EMPTY_FILTERS) : undefined}
          />
        ) : null}
        <RecentlyUsedUp
          search={query}
          onRestored={highlightRestored}
          onExpand={revealUsedUpFooter}
        />
      </>
    ),
    [noMatches, canClear, changeFilters, query, highlightRestored, revealUsedUpFooter],
  );
  const refreshing = inventory.isFetching && !inventory.isPending;
  const { refetch } = inventory;
  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={() => refetch()}
        tintColor={colors.accent}
      />
    ),
    [refreshing, refetch, colors.accent],
  );
  const shownGroup = pendingGroup ?? groupBy;
  const totalCount = allRows.length;
  const controls = useMemo(
    () => (
      <InventoryViewControls
        groupBy={shownGroup}
        onGroupByChange={chooseGroup}
        sortBy={sortBy}
        onSortChange={chooseSort}
        filters={filters}
        onFiltersChange={changeFilters}
        options={options}
        totalCount={totalCount}
      />
    ),
    [shownGroup, chooseGroup, sortBy, chooseSort, filters, changeFilters, options, totalCount],
  );
  const contentStyle = useMemo(
    () => ({ paddingBottom: tabBarHeight + 24 }),
    [tabBarHeight],
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
        <ScrollView
          ref={emptyScroll}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: tabBarHeight + 24 }}
          {...KEYBOARD_SCROLL_PROPS}
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
          <RecentlyUsedUp
            search=""
            onRestored={highlightRestored}
            onExpand={scrollEmptyToEnd}
          />
        </ScrollView>
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
          keyExtractor={rowKey}
          renderItem={renderRow}
          renderSectionHeader={renderSectionHeader}
          pinned={controls}
          layout={motion.layout}
          rowsMotion={motion.rows}
          holdContentHeight={rowCap !== null}
          ref={list}
          {...seenRows.listProps}
          initialNumToRender={INITIAL_CELLS}
          windowSize={WINDOW_SCREENS}
          maxToRenderPerBatch={ROWS_PER_BATCH}
          {...KEYBOARD_SCROLL_PROPS}
          contentContainerStyle={contentStyle}
          refreshControl={refreshControl}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
        />
      </LayoutAnimationConfig>
    </View>
  );
}

function capRows(
  sections: readonly FoodSection[],
  openGroups: Record<string, boolean>,
  rowCap: number | null,
  previous: ReadonlyMap<string, ListSection>,
): ListSection[] {
  let rowsLeft = rowCap ?? Infinity;
  const list: ListSection[] = [];
  for (const section of sections) {
    if (section.data.length === 0) continue;
    if (rowsLeft <= 0) break;
    const open = openGroups[section.key] !== false;
    const data = !open
      ? NO_ROWS
      : rowsLeft >= section.data.length
        ? section.data
        : section.data.slice(0, rowsLeft);
    rowsLeft -= data.length;
    const old = previous.get(section.key);
    list.push(
      old && old.fullSection === section && old.open === open && old.data === data
        ? old
        : { key: section.key, data, fullSection: section, open },
    );
  }
  return list;
}

function rowKey(row: FoodRow): string {
  return row.key;
}

function holdsLot(row: FoodRow, lotId: string): boolean {
  return row.lots.some((lot) => lot.id === lotId);
}
