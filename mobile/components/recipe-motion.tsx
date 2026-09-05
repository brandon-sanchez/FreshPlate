import { useEffect, useRef, type ComponentProps } from "react";
import { Animated, Easing, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
type RecipePressableProps = Omit<ComponentProps<typeof AnimatedPressable>, "style"> & {
  style?: StyleProp<ViewStyle>;
};

export function RecipePressable({
  onPressIn, onPressOut, style, ...props
}: RecipePressableProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) scale.setValue(1);
    return () => scale.stopAnimation();
  }, [reducedMotion, scale]);
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        if (!reducedMotion) Animated.timing(scale, {
          toValue: 0.97, duration: 90, useNativeDriver: true,
        }).start();
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (reducedMotion) scale.setValue(1);
        else Animated.spring(scale, {
          toValue: 1, stiffness: 350, damping: 24, mass: 0.6,
          useNativeDriver: true,
        }).start();
        onPressOut?.(event);
      }}
      style={[style, { transform: [{ scale }] }]}
    />
  );
}

export function RecipeActivity({ reducedMotion }: { reducedMotion: boolean }) {
  const { colors } = useTheme();
  const phase = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducedMotion) {
      phase.setValue(0);
      return;
    }
    const animation = Animated.loop(Animated.timing(phase, {
      toValue: 1, duration: 1500, easing: Easing.linear,
      useNativeDriver: true, isInteraction: false,
    }));
    animation.start();
    return () => animation.stop();
  }, [phase, reducedMotion]);
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0, 1, 2].map((index) => (
        <Animated.View key={index} style={[
          styles.dot, { backgroundColor: colors.accent, opacity: reducedMotion ? 0.6 :
            phase.interpolate({
              inputRange: [0, 0.15 + index * 0.15, 0.3 + index * 0.15, 1],
              outputRange: [0.3, 1, 0.3, 0.3],
            }),
          },
        ]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", alignItems: "center", gap: 5, height: 20 },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
