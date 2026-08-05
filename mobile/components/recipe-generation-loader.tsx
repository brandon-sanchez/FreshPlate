import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useTheme } from "@/hooks/useTheme";

const GENERATION_STEPS = [
  "Checking what is ready in your kitchen",
  "Finding recipe ideas that fit",
  "Making sure every suggestion is grounded",
] as const;

const GENERATION_STEP_INTERVAL_MS = 6500;

export default function RecipeGenerationLoader() {
  const { colors, fonts } = useTheme();
  const [stepIndex, setStepIndex] = useState(0);

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

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.iconCircle, { backgroundColor: colors.accentSoft }]}>
        <Feather name="zap" size={25} color={colors.accent} />
      </View>
      <Text style={[styles.title, { color: colors.text, fontFamily: fonts.display }]}>
        Your kitchen, interpreted
      </Text>
      <Text style={[styles.step, { color: colors.textMuted, fontFamily: fonts.body }]}>
        {GENERATION_STEPS[stepIndex]}
      </Text>
      <View style={styles.progressRow} accessibilityLabel="Recipe generation progress">
        {GENERATION_STEPS.map((label, index) => (
          <View
            key={label}
            style={[
              styles.progressSegment,
              {
                backgroundColor:
                  index <= stepIndex ? colors.accent : colors.surfaceAlt,
              },
            ]}
          />
        ))}
      </View>
      <Text style={[styles.caption, { color: colors.textSubtle, fontFamily: fonts.body }]}>
        Building the first batch can take a little longer
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
    gap: 12,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 22,
    letterSpacing: -0.5,
    textAlign: "center",
  },
  step: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    minHeight: 38,
  },
  progressRow: {
    width: "100%",
    maxWidth: 260,
    flexDirection: "row",
    gap: 5,
    marginTop: 4,
  },
  progressSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  caption: {
    fontSize: 12,
    marginTop: 2,
  },
});
