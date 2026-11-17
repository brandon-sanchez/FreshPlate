import {
  Children,
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  SectionList,
  StyleSheet,
  type LayoutChangeEvent,
  type SectionListData,
  type SectionListProps,
  type StyleProp,
  type ViewStyle,
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

/**
 * Props for {@link PinnedSectionList}: a SectionList's props without the
 * ones it sets itself, plus the pinned content and the layout transition.
 */
export type PinnedSectionListProps<ItemT, SectionT> = Omit<
  SectionListProps<ItemT, SectionT>,
  | "sections"
  | "renderSectionHeader"
  | "stickySectionHeadersEnabled"
  | "StickyHeaderComponent"
  | "CellRendererComponent"
  | "onScroll"
  | "scrollEventThrottle"
> & {
  /** The sections, below the pinned content. */
  sections: readonly SectionListData<ItemT, SectionT>[];
  /** Renders a section's header, which sticks below the pinned content. */
  renderSectionHeader: (info: {
    section: SectionListData<ItemT, SectionT>;
  }) => ReactElement | null;
  /** The content to pin, such as the list's controls. It sits after `ListHeaderComponent`. */
  pinned: ReactNode;
  /** The transition cells and section headers move to new places with. Omit to move them at once. */
  layout?: LayoutAnimationFunction;
};

type StickyFrame = {
  scrollY: SharedValue<number>;
  pinTop: SharedValue<number>;
  pinHeight: SharedValue<number>;
  layout?: LayoutAnimationFunction;
};

const StickyFrameContext = createContext<StickyFrame | null>(null);

// The pinned content rides as the header of a section of its own, with no
// rows, so the list keeps it mounted and makes it sticky.
const PINNED_SECTION = { key: "pinned", data: [] };

const AnimatedSectionList = Animated.createAnimatedComponent(
  SectionList<unknown, unknown>,
);

/**
 * A virtualized SectionList whose `pinned` content scrolls with the list
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
export default function PinnedSectionList<ItemT, SectionT>({
  sections,
  renderSectionHeader,
  pinned,
  layout,
  ...listProps
}: PinnedSectionListProps<ItemT, SectionT>) {
  const scrollY = useSharedValue(0);
  const pinTop = useSharedValue(0);
  const pinHeight = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const frame = useMemo<StickyFrame>(
    () => ({ scrollY, pinTop, pinHeight, layout }),
    [scrollY, pinTop, pinHeight, layout],
  );
  const allSections = useMemo(
    () => [PINNED_SECTION, ...sections] as SectionListData<unknown, unknown>[],
    [sections],
  );
  const renderHeader = useCallback(
    ({ section }: { section: SectionListData<unknown, unknown> }) =>
      section === PINNED_SECTION ? (
        <PinnedBar scrollY={scrollY} top={pinTop}>
          {pinned}
        </PinnedBar>
      ) : (
        renderSectionHeader({
          section: section as SectionListData<ItemT, SectionT>,
        })
      ),
    [pinned, renderSectionHeader, scrollY, pinTop],
  );

  return (
    <StickyFrameContext.Provider value={frame}>
      <AnimatedSectionList
        {...(listProps as SectionListProps<unknown, unknown>)}
        sections={allSections}
        renderSectionHeader={renderHeader}
        stickySectionHeadersEnabled
        StickyHeaderComponent={StickyHeader}
        CellRendererComponent={AnimatedCell}
        onScroll={onScroll}
        scrollEventThrottle={16}
      />
    </StickyFrameContext.Provider>
  );
}

function useStickyFrame(): StickyFrame {
  const frame = useContext(StickyFrameContext);
  if (!frame) throw new Error("Render this inside a PinnedSectionList.");
  return frame;
}

type CellProps = {
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Each list cell, given to the SectionList as its `CellRendererComponent`.
 * The layout transition sits on the cell because the list moves whole
 * cells, so a view inside one never changes place.
 */
function AnimatedCell({ children, onLayout, style }: CellProps) {
  const { layout } = useStickyFrame();
  return (
    <Animated.View layout={layout} onLayout={onLayout} style={style}>
      {children}
    </Animated.View>
  );
}

/**
 * The props React Native's VirtualizedList gives each cell element, which
 * the ScrollView hands to {@link StickyHeader} as its child. For a section
 * header cell, `item` is the section.
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
  const pinned = cell.props.item === PINNED_SECTION;

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
