import {
  Children,
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  FlatList,
  StyleSheet,
  type FlatListProps,
  type LayoutChangeEvent,
  type ScrollView,
  type StyleProp,
  type ViewStyle,
  type ViewToken,
} from "react-native";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type LayoutAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";
import PinnedBar from "@/components/PinnedBar";
import { pinnedOffset, stickyOffset } from "@/lib/stickyOffset";

/** One section of a {@link PinnedSectionList}: a header and the rows below it. */
export type PinnedSection<RowT> = {
  /** Unique among the sections. */
  key: string;
  /** The rows under the header, in order. */
  data: readonly RowT[];
};

/**
 * Props for {@link PinnedSectionList}: the FlatList props it passes on,
 * plus the sections, the pinned content and the motion.
 */
export type PinnedSectionListProps<RowT, SectionT extends PinnedSection<RowT>> = Pick<
  FlatListProps<RowT>,
  | "ListHeaderComponent"
  | "ListFooterComponent"
  | "contentContainerStyle"
  | "refreshControl"
  | "initialNumToRender"
  | "maxToRenderPerBatch"
  | "windowSize"
  | "viewabilityConfig"
  | "extraData"
  | "keyboardDismissMode"
  | "keyboardShouldPersistTaps"
  | "automaticallyAdjustKeyboardInsets"
> & {
  /** The sections, below the pinned content. */
  sections: readonly SectionT[];
  /**
   * Renders a row. `index` is the row's position in its section. Keep it
   * stable: a new function renders every mounted row again.
   */
  renderItem: (info: { item: RowT; index: number }) => ReactElement | null;
  /** Renders a section's header, which sticks below the pinned content. Keep it stable. */
  renderSectionHeader: (info: { section: SectionT }) => ReactElement | null;
  /** Returns a row's key, unique in the whole list. */
  keyExtractor: (row: RowT) => string;
  /** Called with the rows that come into or leave view. */
  onViewableItemsChanged?: (info: {
    viewableItems: ViewToken<RowT>[];
    changed: ViewToken<RowT>[];
  }) => void;
  /** The content to pin, such as the list's controls. It sits after `ListHeaderComponent`. */
  pinned: ReactNode;
  /** The transition cells and section headers move to new places with. Omit to move them at once. */
  layout?: LayoutAnimationFunction;
  /** An opacity and sideways offset, in points, that every row and section header take together. The pinned content stays put. */
  rowsMotion: {
    opacity: SharedValue<number>;
    translateX: SharedValue<number>;
  };
  /**
   * While true, the scroll content keeps at least the height it had when
   * this turned true, so emptying the list doesn't pull the scroll position
   * or the pinned content with it.
   */
  holdContentHeight?: boolean;
  /** Receives {@link PinnedSectionListHandle}. */
  ref?: Ref<PinnedSectionListHandle>;
};

/** Calls a screen can make on a {@link PinnedSectionList}. */
export type PinnedSectionListHandle = {
  /** Scrolls up to where the pinned content just reaches the top, if the list is scrolled past that point. */
  scrollToPinned: () => void;
  /** Scrolls to the end of the content, so a footer that just opened is in view. */
  scrollToEnd: () => void;
};

type Cell<RowT, SectionT> =
  | { kind: "pinned" }
  | { kind: "header"; section: SectionT }
  | { kind: "row"; row: RowT; index: number };

type StickyFrame = {
  scrollY: SharedValue<number>;
  pinTop: SharedValue<number>;
  pinHeight: SharedValue<number>;
  layout?: LayoutAnimationFunction;
  rowsOpacity: SharedValue<number>;
  rowsTranslateX: SharedValue<number>;
};

const StickyFrameContext = createContext<StickyFrame | null>(null);
const PinnedContentContext = createContext<ReactNode>(null);

// The pinned content rides in the first cell, which the list always keeps
// mounted, and which sticks like a section header.
const PINNED_CELL = { kind: "pinned" } as const;

const AnimatedFlatList = Animated.createAnimatedComponent(
  FlatList<Cell<unknown, unknown>>,
);

/**
 * A virtualized sectioned list whose `pinned` content scrolls with the list
 * until it reaches the top and then stays there, with a hairline that fades
 * in as rows pass under it. Each section header sticks just below the pinned
 * content until the next section's header pushes it away.
 *
 * React Native's own sticky headers all stick at the top edge, so pinned
 * content there would hide each section header and be pushed away by the
 * first one. Here every header moves on the UI thread from the scroll
 * offset, and stays a direct child of the scroll content so its taps land
 * wherever it sits.
 */
export default function PinnedSectionList<
  RowT,
  SectionT extends PinnedSection<RowT>,
>({
  sections,
  renderItem,
  renderSectionHeader,
  keyExtractor,
  onViewableItemsChanged,
  pinned,
  layout,
  rowsMotion,
  holdContentHeight = false,
  contentContainerStyle,
  ref,
  ...listProps
}: PinnedSectionListProps<RowT, SectionT>) {
  const scrollY = useSharedValue(0);
  const { opacity: rowsOpacity, translateX: rowsTranslateX } = rowsMotion;
  const pinTop = useSharedValue(0);
  const pinHeight = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const frame = useMemo<StickyFrame>(
    () => ({
      scrollY,
      pinTop,
      pinHeight,
      layout,
      rowsOpacity,
      rowsTranslateX,
    }),
    [scrollY, pinTop, pinHeight, layout, rowsOpacity, rowsTranslateX],
  );
    // Reanimated's wrapper drops FlatList's item type and ref.
  const List = AnimatedFlatList as unknown as ComponentType<
    FlatListProps<Cell<RowT, SectionT>> & {
      ref?: Ref<FlatList<Cell<RowT, SectionT>>>;
      // FlatList takes `strictMode` (react-native/Libraries/Lists/FlatList.js)
      // but its TypeScript types leave it out.
      strictMode?: boolean;
    }
  >;
  const previousCells = useRef(new Map<unknown, Cell<RowT, SectionT>>());
  const hasListHeader = listProps.ListHeaderComponent != null;
  const { cells, stickyHeaderIndices } = useMemo(() => {
    const previous = previousCells.current;
    const next = new Map<unknown, Cell<RowT, SectionT>>();
    const flat: Cell<RowT, SectionT>[] = [PINNED_CELL];
    // A sticky index counts `ListHeaderComponent` as the first child.
    const headerOffset = hasListHeader ? 1 : 0;
    const sticky = [headerOffset];
    for (const section of sections) {
      sticky.push(flat.length + headerOffset);
      const header =
        previous.get(section) ?? ({ kind: "header", section } as const);
      next.set(section, header);
      flat.push(header);
      section.data.forEach((row, index) => {
        const old = previous.get(row);
        const cell =
          old?.kind === "row" && old.index === index
            ? old
            : ({ kind: "row", row, index } as const);
        next.set(row, cell);
        flat.push(cell);
      });
    }
    previousCells.current = next;
    return { cells: flat, stickyHeaderIndices: sticky };
  }, [sections, hasListHeader]);

  const renderCell = useCallback(
    ({ item }: { item: Cell<RowT, SectionT> }) => {
      if (item.kind === "row")
        return renderItem({ item: item.row, index: item.index });
      if (item.kind === "header")
        return renderSectionHeader({ section: item.section });
      return (
        <PinnedBar scrollY={scrollY} top={pinTop}>
          <PinnedContent />
        </PinnedBar>
      );
    },
    [renderItem, renderSectionHeader, scrollY, pinTop],
  );
  const cellKey = useCallback(
    (item: Cell<RowT, SectionT>) =>
      item.kind === "row"
        ? keyExtractor(item.row)
        : item.kind === "header"
          ? `header:${item.section.key}`
          : "pinned",
    [keyExtractor],
  );

  const reportViewableRows = useCallback(
    (info: {
      viewableItems: ViewToken<Cell<RowT, SectionT>>[];
      changed: ViewToken<Cell<RowT, SectionT>>[];
    }) => {
      const rowsOnly = (tokens: ViewToken<Cell<RowT, SectionT>>[]) =>
        tokens.flatMap((token) =>
          token.item.kind === "row"
            ? [{ ...token, item: token.item.row, index: token.item.index }]
            : [],
        );
      onViewableItemsChanged?.({
        viewableItems: rowsOnly(info.viewableItems),
        changed: rowsOnly(info.changed),
      });
    },
    [onViewableItemsChanged],
  );

  const listRef = useRef<FlatList<Cell<RowT, SectionT>>>(null);
  useImperativeHandle(
    ref,
    () => ({
      scrollToPinned: () => {
        if (scrollY.value > pinTop.value)
          listRef.current?.scrollToOffset({
            offset: pinTop.value,
            animated: false,
          });
      },
      // FlatList's own scrollToEnd measures the footer from its last
      // onLayout, which a footer that just grew hasn't sent yet. The scroll
      // view's ref, typed loosely by React Native, scrolls by the laid-out
      // content size.
      scrollToEnd: () => {
        const scroll = listRef.current?.getNativeScrollRef() as unknown as ScrollView | null;
        scroll?.scrollToEnd({ animated: true });
      },
    }),
    [scrollY, pinTop],
  );

  const contentHeight = useRef(0);
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    setHeldHeight(holdContentHeight ? contentHeight.current : null);
  }, [holdContentHeight]);
  const contentStyle = useMemo(
    () =>
      heldHeight === null
        ? contentContainerStyle
        : [contentContainerStyle, { minHeight: heldHeight }],
    [contentContainerStyle, heldHeight],
  );

  return (
    <StickyFrameContext.Provider value={frame}>
      <PinnedContentContext.Provider value={pinned}>
      <List
        {...listProps}
        ref={listRef}
        // The list then renders a cell again only when its item changes, so
        // a re-sort or a regroup step leaves unchanged rows alone.
        strictMode
        contentContainerStyle={contentStyle}
        onContentSizeChange={(_, height) => {
          contentHeight.current = height;
        }}
        data={cells}
        renderItem={renderCell}
        keyExtractor={cellKey}
        onViewableItemsChanged={reportViewableRows}
        stickyHeaderIndices={stickyHeaderIndices}
        StickyHeaderComponent={StickyHeader}
        CellRendererComponent={AnimatedCell}
        onScroll={onScroll}
        scrollEventThrottle={16}
      />
      </PinnedContentContext.Provider>
    </StickyFrameContext.Provider>
  );
}

function PinnedContent() {
  return <>{useContext(PinnedContentContext)}</>;
}

function useStickyFrame(): StickyFrame {
  const frame = useContext(StickyFrameContext);
  if (!frame) throw new Error("Render this inside a PinnedSectionList.");
  return frame;
}

type CellProps = {
  item: unknown;
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Each list cell, given to the FlatList as its `CellRendererComponent`.
 * The layout transition sits on the cell because the list moves whole
 * cells, so a view inside one never changes place.
 */
function AnimatedCell({ item, children, onLayout, style }: CellProps) {
  const { layout, rowsOpacity, rowsTranslateX } = useStickyFrame();
  const pinned = item === PINNED_CELL;
  const rowsStyle = useAnimatedStyle(() =>
    pinned
      ? {}
      : {
          opacity: rowsOpacity.value,
          transform: [{ translateX: rowsTranslateX.value }],
        },
  );
  return (
    <Animated.View
      layout={layout}
      onLayout={onLayout}
      style={[style, rowsStyle]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * The props React Native's VirtualizedList gives each cell element, which
 * the ScrollView hands to {@link StickyHeader} as its child.
 */
type CellElement = ReactElement<{
  item: unknown;
  cellKey: string;
  index: number;
  onCellLayout?: (event: LayoutChangeEvent, cellKey: string, index: number) => void;
}>;

type StickyHeaderProps = {
  children?: ReactNode;
  onLayout: (event: LayoutChangeEvent) => void;
  nextHeaderLayoutY?: number;
  ref?: Ref<{ setNextHeaderY: (y: number) => void }>;
};

/**
 * Each sticky header, given to the ScrollView as its `StickyHeaderComponent`.
 * The ScrollView passes where the next sticky header starts, through the
 * `nextHeaderLayoutY` prop and the `setNextHeaderY` handle.
 */
function StickyHeader({
  children,
  onLayout,
  nextHeaderLayoutY,
  ref,
}: StickyHeaderProps) {
  const { scrollY, pinTop, pinHeight, layout } = useStickyFrame();
  const cell = Children.only(children) as CellElement;
  const pinned = cell.props.item === PINNED_CELL;

  const top = useSharedValue(0);
  const height = useSharedValue(-1);
  const nextTop = useSharedValue<number | null>(nextHeaderLayoutY ?? null);
  useEffect(() => {
    nextTop.value = nextHeaderLayoutY ?? null;
  }, [nextTop, nextHeaderLayoutY]);
  useImperativeHandle(
    ref,
    () => ({
      setNextHeaderY: (y: number) => {
        nextTop.value = y;
      },
    }),
    [nextTop],
  );

  const stickStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: pinned
          ? pinnedOffset(scrollY.value, top.value)
          : stickyOffset({
              scrollY: scrollY.value,
              pinHeight: pinHeight.value,
              top: top.value,
              height: height.value,
              nextTop: nextTop.value,
            }),
      },
    ],
  }));

  // The cell sits at the top of this wrapper, so the list records the
  // wrapper's layout as the cell's.
  const reportLayout = (event: LayoutChangeEvent) => {
    const { y, height: h } = event.nativeEvent.layout;
    top.value = y;
    height.value = h;
    if (pinned) {
      pinTop.value = y;
      pinHeight.value = h;
    }
    onLayout(event);
    cell.props.onCellLayout?.(event, cell.props.cellKey, cell.props.index);
  };

  return (
    <Animated.View
      collapsable={false}
      layout={pinned ? undefined : layout}
      onLayout={reportLayout}
      style={[pinned ? styles.pinned : styles.sticky, stickStyle]}
    >
      {cloneElement(cell, { onCellLayout: undefined })}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pinned: { zIndex: 20 },
  sticky: { zIndex: 10 },
});
