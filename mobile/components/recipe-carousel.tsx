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
import { useTheme } from "@/hooks/useTheme";

export type RecipeCarouselItem = {
  id: string;
  content: ReactNode;
  isRecipe: boolean;
};

const transition = { duration: 360, easing: Easing.inOut(Easing.cubic) };
const dragDistance = 180;

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

  const select = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(lastIndex, index));
      activeRef.current = next;
      setSelectedIndex(next);
      position.value = reducedMotion ? next : withTiming(next, transition);
    },
    [lastIndex, position, reducedMotion],
  );

  useEffect(() => {
    activeRef.current = activeIndex;
    if (selectedIndex !== activeIndex) select(activeIndex);
    onActiveIndexChange(activeIndex);
  }, [
    activeIndex,
    items[activeIndex]?.id,
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
            .filter(({ index }) => Math.abs(index - activeIndex) <= 4)
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
          {items[activeIndex]?.isRecipe
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
}) {
  const slotIndex = useSharedValue(index);
  useLayoutEffect(() => {
    slotIndex.value = reducedMotion ? index : withTiming(index, transition);
  }, [index, reducedMotion, slotIndex]);
  const style = useAnimatedStyle(() => {
    const distance = slotIndex.value - position.value;
    const depth = Math.min(3.5, Math.abs(distance));
    const scale = 1 - depth * 0.12;
    return {
      zIndex: Math.round(100 - Math.abs(distance) * 10),
      opacity: Math.max(0, Math.min(1, 4 - Math.abs(distance))),
      transform: [
        {
          translateY:
            Math.sign(distance) *
            ((cardHeight * (1 - scale)) / 2 + depth * peek),
        },
        { scale },
      ],
    };
  }, [cardHeight, peek]);
  const dimStyle = useAnimatedStyle(() => ({
    opacity: Math.min(0.8, Math.abs(slotIndex.value - position.value) * 0.24),
  }));
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
      {children}
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
    </Animated.View>
  );
}

const styles = StyleSheet.create({
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
