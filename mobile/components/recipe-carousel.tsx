import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Feather from "@expo/vector-icons/Feather";
import { RecipePressable } from "@/components/recipe-motion";
import RecipeSweepExit from "@/components/recipe-sweep-exit";
import { useTheme } from "@/hooks/useTheme";

/** One slot in {@link RecipeCarousel}. */
export type RecipeCarouselItem = {
  /** Stable key for the slot. */
  id: string;
  content: ReactNode;
  /**
   * `recipe` and `loading` slots stack like cards. A `message` slot has no
   * card of its own: it fades in once centered, and the recipe cards slide
   * above the stage while it shows.
   */
  kind: "recipe" | "loading" | "message";
  /**
   * Set while the slot's card leaves in a sweep: its exit delay in
   * milliseconds.
   */
  exitDelayMs?: number;
};

const transition = { duration: 360, easing: Easing.inOut(Easing.cubic) };
const GAP_ABOVE_STAGE = 32;
const VISIBLE_STACK_DEPTH = 4;

const dragDistance = 180;

/**
 * Returns how far the carousel has moved from the slot before the message
 * onto the message: 0 up to that slot, 1 once the message is centered.
 */
function progressOntoMessage(position: number, messageIndex: number | null) {
  "worklet";
  if (messageIndex === null) return 0;
  return Math.max(0, Math.min(1, position - (messageIndex - 1)));
}

// Native adaptation of 21st's Scrollable Card Stack, with a centered,
// two-sided stack and finite navigation matching the recipe cursor order.
export default function RecipeCarousel({
  items,
  cardHeight,
  reducedMotion,
  onActiveIndexChange,
}: {
  items: RecipeCarouselItem[];
  cardHeight: number;
  reducedMotion: boolean;
  onActiveIndexChange: (index: number) => void;
}) {
  const { colors, fonts } = useTheme();
  const [height, setHeight] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const lastIndex = Math.max(0, items.length - 1);
  const activeIndex = Math.min(selectedIndex, lastIndex);
  const activeRef = useRef(activeIndex);
  const position = useSharedValue(activeIndex);
  const dragStart = useSharedValue(activeIndex);
  const dragging = useSharedValue(false);
  const peek = Math.max(20, Math.min(48, (height - cardHeight) / 4));
  const firstMessage = items.findIndex((item) => item.kind === "message");
  const messageIndex = firstMessage === -1 ? null : firstMessage;

  const select = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(lastIndex, index));
      activeRef.current = next;
      setSelectedIndex(next);
      position.value = reducedMotion ? next : withTiming(next, transition);
    },
    [lastIndex, position, reducedMotion],
  );

  const activeItemId = items[activeIndex]?.id;
  useEffect(() => {
    activeRef.current = activeIndex;
    if (selectedIndex !== activeIndex) select(activeIndex);
    onActiveIndexChange(activeIndex);
  }, [
    activeIndex,
    activeItemId,
    onActiveIndexChange,
    select,
    selectedIndex,
  ]);

  const finishDrag = useCallback((index: number) => {
    activeRef.current = index;
    setSelectedIndex(index);
  }, []);

  const pan = Gesture.Pan()
    .withTestId("recipe-carousel-pan")
    .activeOffsetY([-12, 12])
    .failOffsetX([-28, 28])
    .onStart(() => {
      cancelAnimation(position);
      dragStart.value = position.value;
      dragging.value = true;
    })
    .onUpdate((event) => {
      if (!reducedMotion) {
        position.value = Math.max(
          0,
          Math.min(
            lastIndex,
            dragStart.value +
              Math.max(-2, Math.min(2, -event.translationY / dragDistance)),
          ),
        );
      }
    })
    .onEnd((event) => {
      const projected =
        dragStart.value -
        (event.translationY + event.velocityY * 0.12) / dragDistance;
      // A fling may advance two cards. Bound it so unseen cards cannot all
      // disappear in one gesture and the mounted neighbors cover the motion.
      const step = Math.max(
        -2,
        Math.min(2, Math.round(projected - dragStart.value)),
      );
      const next = Math.max(
        0,
        Math.min(lastIndex, Math.round(dragStart.value) + step),
      );
      position.value = reducedMotion ? next : withTiming(next, transition);
      dragging.value = false;
      runOnJS(finishDrag)(next);
    })
    .onFinalize(() => {
      if (dragging.value) {
        const next = Math.max(
          0,
          Math.min(lastIndex, Math.round(dragStart.value)),
        );
        position.value = reducedMotion ? next : withTiming(next, transition);
        dragging.value = false;
        runOnJS(finishDrag)(next);
      }
    });

  return (
    <View style={{ flex: 1 }} testID="recipe-carousel">
      <GestureDetector gesture={pan}>
        <Animated.View
          testID="recipe-carousel-stage"
          collapsable={false}
          onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
          style={{ flex: 1, overflow: "hidden" }}
        >
          {items
            .map((item, index) => ({ item, index }))
            .filter(({ index }) => Math.abs(index - activeIndex) <= VISIBLE_STACK_DEPTH)
            .map(({ item, index }) => (
              <CarouselSlot
                key={item.id}
                index={index}
                position={position}
                height={height}
                cardHeight={cardHeight}
                peek={peek}
                reducedMotion={reducedMotion}
                dimColor={colors.bg}
                active={index === activeIndex}
                isCard={item.kind !== "message"}
                messageIndex={messageIndex}
                exitDelayMs={item.exitDelayMs}
              >
                {item.content}
              </CarouselSlot>
            ))}
        </Animated.View>
      </GestureDetector>
      <View style={styles.navigation}>
        <RecipePressable
          accessibilityRole="button"
          accessibilityLabel="Previous recipe"
          testID="recipe-carousel-previous"
          disabled={activeIndex === 0}
          accessibilityState={{ disabled: activeIndex === 0 }}
          onPress={() => select(activeRef.current - 1)}
          style={[
            styles.navigationButton,
            { opacity: activeIndex === 0 ? 0.3 : 1 },
          ]}
        >
          <Feather name="chevron-up" size={20} color={colors.accent} />
        </RecipePressable>
        <Text
          accessibilityLiveRegion="polite"
          style={{
            color: colors.textMuted,
            fontFamily: fonts.body,
            fontSize: 12,
          }}
        >
          {items[activeIndex]?.kind === "recipe"
            ? `Recipe ${activeIndex + 1}`
            : "This set of ideas"}
        </Text>
        <RecipePressable
          accessibilityRole="button"
          accessibilityLabel="Next recipe"
          testID="recipe-carousel-next"
          disabled={activeIndex === lastIndex}
          accessibilityState={{ disabled: activeIndex === lastIndex }}
          onPress={() => select(activeRef.current + 1)}
          style={[
            styles.navigationButton,
            { opacity: activeIndex === lastIndex ? 0.3 : 1 },
          ]}
        >
          <Feather name="chevron-down" size={20} color={colors.accent} />
        </RecipePressable>
      </View>
    </View>
  );
}

function CarouselSlot({
  children,
  index,
  position,
  cardHeight,
  height,
  peek,
  reducedMotion,
  dimColor,
  active,
  isCard,
  messageIndex,
  exitDelayMs,
}: {
  children: ReactNode;
  index: number;
  position: SharedValue<number>;
  cardHeight: number;
  height: number;
  peek: number;
  reducedMotion: boolean;
  dimColor: string;
  active: boolean;
  isCard: boolean;
  messageIndex: number | null;
  exitDelayMs: number | undefined;
}) {
  const slotIndex = useSharedValue(index);
  useLayoutEffect(() => {
    slotIndex.value = reducedMotion ? index : withTiming(index, transition);
  }, [index, reducedMotion, slotIndex]);
  const style = useAnimatedStyle(() => {
    const distance = slotIndex.value - position.value;
    const depth = Math.min(3.5, Math.abs(distance));
    const stackScale = 1 - depth * 0.12;
    const stackY =
      Math.sign(distance) *
      ((cardHeight * (1 - stackScale)) / 2 + depth * peek);
    const toList = isCard
      ? progressOntoMessage(position.value, messageIndex)
      : 0;
    const listY = distance * ((height + cardHeight) / 2 + GAP_ABOVE_STAGE);
    const scale = stackScale + (1 - stackScale) * toList;
    const fade = isCard
      ? VISIBLE_STACK_DEPTH - Math.abs(distance)
      : 1 - Math.abs(distance);
    return {
      zIndex: Math.round(100 - Math.abs(distance) * 10),
      opacity: Math.max(0, Math.min(1, fade)),
      transform: [{ translateY: stackY + (listY - stackY) * toList }, { scale }],
    };
  }, [cardHeight, height, isCard, messageIndex, peek]);
  const dimStyle = useAnimatedStyle(() => {
    const dim = Math.min(
      0.8,
      Math.abs(slotIndex.value - position.value) * 0.24,
    );
    return {
      opacity: dim * (1 - progressOntoMessage(position.value, messageIndex)),
    };
  }, [messageIndex]);
  return (
    <Animated.View
      testID={`recipe-carousel-slot-${index}`}
      pointerEvents={active ? "auto" : "none"}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      style={[
        {
          position: "absolute",
          left: 0,
          right: 0,
          top: (height - cardHeight) / 2,
          height: cardHeight,
        },
        style,
      ]}
    >
      <RecipeSweepExit
        exitDelayMs={exitDelayMs}
        reducedMotion={reducedMotion}
        style={styles.slotContent}
      >
        {children}
        {isCard && (
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              {
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 24,
                right: 24,
                borderRadius: 24,
                backgroundColor: dimColor,
              },
              dimStyle,
            ]}
          />
        )}
      </RecipeSweepExit>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slotContent: { flex: 1 },
  navigation: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  navigationButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
