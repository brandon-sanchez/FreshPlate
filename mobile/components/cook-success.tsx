import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import BlockButton from "@/components/block-button";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

type CookSuccessProps = {
  /** Whether the cooked recipe is in the household's saved recipes. */
  isSaved: boolean;
  /** True while a save is in flight, so a save that may still fail doesn't close the screen. */
  isSaving: boolean;
  /** Called by "Save this recipe". */
  onSave: () => void;
  /** Called by "Done", and by itself shortly after the recipe is saved. */
  onDone: () => void;
};

/** How long the saved state stays on screen before returning, matching the mockup's CookFlow. */
const AUTO_RETURN_MS = 1400;

/**
 * Renders the screen shown after a cook is confirmed: a check that pops in,
 * "Nice plate" and "Your fridge is updated.", then "Save this recipe" and
 * "Done". Once the recipe is saved, whether before the cook or from here, it
 * says so and calls `onDone` by itself after a moment.
 */
export default function CookSuccess({ isSaved, isSaving, onSave, onDone }: CookSuccessProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const pop = useRef(new Animated.Value(0)).current;
  // The latest onDone, so a re-render of the parent doesn't restart the timer.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // useReducedMotion reads true until the setting loads, so the pop restarts
  // from 0 when the setting turns out to allow motion.
  useEffect(() => {
    if (reducedMotion) {
      pop.setValue(1);
      return;
    }
    pop.setValue(0);
    const animation = Animated.timing(pop, {
      toValue: 1,
      duration: 400,
      easing: Easing.out(Easing.back(2)),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [pop, reducedMotion]);

  useEffect(() => {
    if (!isSaved || isSaving) return;
    const timer = setTimeout(() => onDoneRef.current(), AUTO_RETURN_MS);
    return () => clearTimeout(timer);
  }, [isSaved, isSaving]);

  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  const opacity = pop.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 1] });

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <View style={styles.center}>
        <Animated.View
          style={[styles.badge, { backgroundColor: colors.accent, opacity, transform: [{ scale }] }]}
        >
          <Feather name="check" size={40} color={colors.accentInk} />
        </Animated.View>
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: colors.text, fontFamily: fonts.display }]}
        >
          Nice plate
        </Text>
        <Text style={[styles.subtitle, { color: colors.textMuted, fontFamily: fonts.body }]}>
          Your fridge is updated.
        </Text>
        {isSaved ? (
          <View style={styles.savedNote}>
            <Feather name="bookmark" size={15} color={colors.accent} />
            <Text style={[styles.savedText, { color: colors.accent, fontFamily: fonts.bodyStrong }]}>
              Saved to your recipes
            </Text>
          </View>
        ) : null}
      </View>
      <View style={[styles.actions, { paddingBottom: insets.bottom + 14 }]}>
        {isSaved ? null : (
          <BlockButton label="Save this recipe" variant="primary" onPress={onSave} />
        )}
        <BlockButton label="Done" variant="secondary" onPress={onDone} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  badge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 22, letterSpacing: -0.44, marginTop: 20, textAlign: "center" },
  subtitle: { fontSize: 14, marginTop: 6, textAlign: "center" },
  savedNote: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 16 },
  savedText: { fontSize: 13 },
  actions: { gap: 10, paddingHorizontal: 16, paddingTop: 16 },
});
