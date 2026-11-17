import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useImperativeHandle,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  StyleSheet,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type LayoutAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";

/** What {@link StickyListHeader} needs from the screen, through {@link StickyListContext}. */
export type StickyListFrame = {
  /** The list's vertical scroll offset, in points. */
  scrollY: SharedValue<number>;
  /** Receives where the pinned header sits in the list content, in points. */
  pinTop: SharedValue<number>;
  /** Receives the pinned header's height, in points; the other headers stick below it. */
  pinHeight: SharedValue<number>;
  /** The list item whose header pins to the top and is never pushed away. */
  pinnedItem: unknown;
  /** The layout transition for the other headers, so they move with the rows. */
  layout?: LayoutAnimationFunction;
};

/** Provides the {@link StickyListFrame} that every {@link StickyListHeader} reads. */
export const StickyListContext = createContext<StickyListFrame | null>(null);

/** The handle a ScrollView keeps for each sticky header. */
type StickyHeaderHandle = {
  /** Called by the ScrollView with where the next sticky header starts. */
  setNextHeaderY: (y: number) => void;
};

type StickyListHeaderProps = {
  /** The list cell to make sticky. The ScrollView passes it. */
  children?: ReactNode;
  /** Reports the header's layout back to the ScrollView. */
  onLayout: (event: LayoutChangeEvent) => void;
  /** Where the next sticky header starts in the list content, when it has been laid out. */
  nextHeaderLayoutY?: number;
  /** The handle the ScrollView uses to update `nextHeaderLayoutY`. */
  ref?: Ref<StickyHeaderHandle>;
};

type CellElement = ReactElement<{
  item?: unknown;
  style?: unknown;
  onLayout?: (event: LayoutChangeEvent) => void;
}>;

const NO_NEXT_HEADER = -1;

/**
 * A sticky header for a SectionList, passed as its `StickyHeaderComponent`.
 * The header of `pinnedItem` scrolls with the list until it reaches the top
 * and then stays there. Every other section header sticks just below it
 * until the next section's header pushes it away.
 *
 * React Native's own sticky headers all stick at the top edge, so a header
 * pinned there would hide each section header and be pushed away by the
 * first one. Each header moves on the UI thread from `scrollY`, and stays a
 * direct child of the scroll content so its taps land wherever it sits.
 */
export default function StickyListHeader({
  children,
  onLayout,
  nextHeaderLayoutY,
  ref,
}: StickyListHeaderProps) {
  const frame = useContext(StickyListContext);
  if (!frame) throw new Error("StickyListHeader needs a StickyListContext.");
  const { scrollY, pinTop, pinHeight, pinnedItem, layout } = frame;
  const cell = Children.only(children) as CellElement;
  // A SectionList passes the section as the item of its header cell.
  const pinned = isValidElement(cell) && cell.props.item === pinnedItem;

  const top = useSharedValue(0);
  const height = useSharedValue(0);
  const nextTop = useSharedValue(nextHeaderLayoutY ?? NO_NEXT_HEADER);
  useImperativeHandle(
    ref,
    () => ({
      setNextHeaderY: (y: number) => {
        nextTop.value = y;
      },
    }),
    [nextTop],
  );

  const stickStyle = useAnimatedStyle(() => {
    if (pinned) {
      return {
        transform: [{ translateY: Math.max(0, scrollY.value - top.value) }],
      };
    }
    const overlap = scrollY.value + pinHeight.value - top.value;
    const room =
      nextTop.value === NO_NEXT_HEADER
        ? overlap
        : nextTop.value - height.value - top.value;
    return {
      transform: [{ translateY: Math.max(0, Math.min(overlap, room)) }],
    };
  });

  const handleLayout = (event: LayoutChangeEvent) => {
    const { y, height: h } = event.nativeEvent.layout;
    top.value = y;
    height.value = h;
    if (pinned) {
      pinTop.value = y;
      pinHeight.value = h;
    }
    onLayout(event);
    // The cell's own layout is relative to this wrapper, so it gets this one.
    cell.props.onLayout?.(event);
  };

  return (
    <Animated.View
      collapsable={false}
      layout={pinned ? undefined : layout}
      onLayout={handleLayout}
      style={[
        cell.props.style as object,
        pinned ? styles.pinned : styles.sticky,
        stickStyle,
      ]}
    >
      {cloneElement(cell, { style: styles.fill, onLayout: undefined })}
    </Animated.View>
  );
}

type StickyListCellProps = {
  /** The cell's content. */
  children?: ReactNode;
  /** Reports the cell's layout to the list. */
  onLayout?: (event: LayoutChangeEvent) => void;
  /** The list's style for the cell. */
  style?: StyleProp<ViewStyle>;
};

/**
 * A list cell, passed as the SectionList's `CellRendererComponent`, that
 * moves to a new place with the layout transition in
 * {@link StickyListContext}. The transition has to sit on the cell: the
 * list moves whole cells, so a view inside one never changes place.
 */
export function StickyListCell({
  children,
  onLayout,
  style,
}: StickyListCellProps) {
  const frame = useContext(StickyListContext);
  return (
    <Animated.View
      layout={frame?.layout}
      onLayout={onLayout}
      style={style}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pinned: { zIndex: 20 },
  sticky: { zIndex: 10 },
  fill: { flex: 1 },
});
