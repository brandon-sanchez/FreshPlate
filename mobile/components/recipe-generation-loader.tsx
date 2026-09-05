import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { useReducedMotion } from "@/hooks/useReducedMotion";

const GENERATION_STEPS = [
  "Starting with what's in your kitchen",
  "Finding a few ideas for you",
  "Giving your recipes a final look",
];
const GENERATION_STEP_INTERVAL_MS = 6500;

// Native adaptation of @beratberkayg's 21st AI Loader circle and staggered letters.
export default function RecipeGenerationLoader() {
  const { colors, fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  const [stepIndex, setStepIndex] = useState(0);
  const rotation = useRef(new Animated.Value(0)).current;
  const letters = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const interval = setInterval(() => {
      setStepIndex((current) => {
        if (current >= GENERATION_STEPS.length - 1) {
          clearInterval(interval);
          return current;
        }
        return current + 1;
      });
    }, GENERATION_STEP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      rotation.setValue(0);
      letters.setValue(0);
      return;
    }
    const spin = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 5000,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    const shimmer = Animated.loop(
      Animated.timing(letters, {
        toValue: 1,
        duration: 3000,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    spin.start();
    shimmer.start();
    return () => {
      spin.stop();
      shimmer.stop();
    };
  }, [letters, reducedMotion, rotation]);

  return (
    <View
      testID="recipe-generation-loader"
      style={[styles.container, { backgroundColor: colors.bg }]}
    >
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Generating recipes"
        style={styles.loader}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.ringBase, { borderColor: colors.accentSoft }]}
        />
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.ringLayer,
            {
              transform: [
                {
                  rotate: rotation.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["90deg", "450deg"],
                  }),
                },
              ],
            },
          ]}
        >
          <View
            style={[
              styles.ringGlow,
              {
                borderBottomColor: colors.accent,
                borderLeftColor: colors.accentSoft,
                shadowColor: colors.accent,
              },
            ]}
          />
          <View
            style={[
              styles.ringEdge,
              {
                borderBottomColor: colors.accent,
                borderRightColor: colors.accentSoft,
                shadowColor: colors.accent,
              },
            ]}
          />
          <View
            style={[styles.ringInner, { borderBottomColor: colors.accentSoft }]}
          />
        </Animated.View>
        <View
          style={styles.letters}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {"Generating".split("").map((letter, index) => (
            <Animated.Text
              key={index}
              style={[
                styles.letter,
                {
                  color: colors.accent,
                  fontFamily: fonts.bodyStrong,
                  opacity: reducedMotion
                    ? 1
                    : letters.interpolate({
                        inputRange: [
                          0,
                          0.04 + index * 0.026,
                          0.16 + index * 0.026,
                          0.32 + index * 0.026,
                          1,
                        ],
                        outputRange: [0.4, 0.4, 1, 0.4, 0.4],
                      }),
                  transform: [
                    {
                      scale: reducedMotion
                        ? 1
                        : letters.interpolate({
                            inputRange: [
                              0,
                              0.04 + index * 0.026,
                              0.16 + index * 0.026,
                              0.32 + index * 0.026,
                              1,
                            ],
                            outputRange: [1, 1, 1.15, 1, 1],
                          }),
                    },
                  ],
                },
              ]}
            >
              {letter}
            </Animated.Text>
          ))}
        </View>
      </View>
      <Text
        style={[
          styles.title,
          { color: colors.text, fontFamily: fonts.display },
        ]}
      >
        A little kitchen inspiration
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        style={[
          styles.step,
          { color: colors.textMuted, fontFamily: fonts.body },
        ]}
      >
        {GENERATION_STEPS[stepIndex]}
      </Text>
      <Text
        style={[
          styles.caption,
          { color: colors.textMuted, fontFamily: fonts.body },
        ]}
      >
        Good ideas take a moment.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingBottom: 24,
  },
  loader: {
    width: 180,
    height: 180,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 40,
  },
  ringBase: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 90,
    borderWidth: 1,
  },
  ringLayer: { ...StyleSheet.absoluteFillObject },
  ringGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 90,
    borderWidth: 12,
    borderColor: "transparent",
    opacity: 0.3,
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
  ringEdge: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 90,
    borderWidth: 3,
    borderColor: "transparent",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  ringInner: {
    position: "absolute",
    inset: 8,
    borderRadius: 82,
    borderWidth: 9,
    borderColor: "transparent",
    opacity: 0.6,
  },
  letters: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  letter: { fontSize: 14, lineHeight: 22, letterSpacing: 0.4 },
  title: {
    fontSize: 26,
    lineHeight: 33,
    letterSpacing: -0.6,
    textAlign: "center",
  },
  step: {
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginTop: 12,
    minHeight: 42,
  },
  caption: { fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 24 },
});
