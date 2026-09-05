import { useMemo, useState } from "react";
import {

  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { RecipePressable } from "@/components/recipe-motion";
import { useTheme } from "@/hooks/useTheme";
import type {
  RecipePreferenceKey,
  RecipePreferences,
} from "@/types/recipes";

type PreferenceStep = {
  key: RecipePreferenceKey;
  label: string;
  helperText?: string;
  options?: readonly string[];
  freeText?: boolean;
  placeholder?: string;
};

export const RECIPE_PREFERENCE_STEPS: readonly PreferenceStep[] = [
  {
    key: "meal",
    label: "Which meal?",
    helperText: "Start broad - we'll narrow down.",
    options: ["Breakfast", "Lunch", "Dinner", "Snack", "Dessert"],
  },
  {
    key: "time",
    label: "How much time?",
    helperText: "Faster answers mean fewer steps on the stove.",
    options: ["<15 min", "<30 min", "<60 min", "I have all night"],
  },
  {
    key: "mood",
    label: "What mood?",
    options: ["Comfort", "Light & clean", "Adventurous", "Fancy"],
  },
  {
    key: "cuisine",
    label: "Cuisine vibe?",
    options: [
      "Mediterranean",
      "East Asian",
      "Italian",
      "Mexican",
      "South Asian",
      "Whatever works",
    ],
  },
  {
    key: "diet",
    label: "Any diet goals?",
    options: [
      "High protein",
      "Keto",
      "Vegan",
      "Vegetarian",
      "Gluten-free",
      "None",
    ],
  },
  {
    key: "occasion",
    label: "Any occasion or context?",
    helperText:
      "Tell us anything else - who is eating, what you have going on, or a craving.",
    freeText: true,
    placeholder:
      "e.g. date night, feeding a toddler, post-workout, using up tomatoes...",
  },
];

export type RecipePreferenceFlowProps = {
  initialPreferences?: RecipePreferences;
  onComplete: (preferences: RecipePreferences) => void;
  onCancel: () => void;
};

function withoutPreference(
  preferences: RecipePreferences,
  key: RecipePreferenceKey,
): RecipePreferences {
  const next = { ...preferences };
  delete next[key];
  return next;
}

export default function RecipePreferenceFlow({
  initialPreferences = {},
  onComplete,
  onCancel,
}: RecipePreferenceFlowProps) {
  const { colors, fonts } = useTheme();
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<RecipePreferences>(() => ({
    ...initialPreferences,
  }));
  const [occasion, setOccasion] = useState(initialPreferences.occasion ?? "");

  const current = RECIPE_PREFERENCE_STEPS[stepIndex];
  const draftAnswers = useMemo(() => {
    if (!current.freeText) return answers;

    const trimmed = occasion.trim();
    if (trimmed) return { ...answers, occasion: trimmed };
    return withoutPreference(answers, "occasion");
  }, [answers, current.freeText, occasion]);

  const selectOption = (value: string) => {
    const nextAnswers = { ...answers, [current.key]: value };
    setAnswers(nextAnswers);
    setStepIndex((previous) => previous + 1);
  };

  const submitFreeText = () => onComplete(draftAnswers);

  const skipQuestion = () => {
    const nextAnswers = withoutPreference(answers, current.key);
    if (current.freeText) setOccasion("");
    setAnswers(nextAnswers);

    if (stepIndex === RECIPE_PREFERENCE_STEPS.length - 1) {
      onComplete(nextAnswers);
      return;
    }
    setStepIndex((previous) => previous + 1);
  };

  return (
    <ScrollView
      testID="recipe-preference-flow"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.headerRow}>
        <View style={styles.aiLabel}>
          <FontAwesome name="magic" size={13} color={colors.accent} />
          <Text style={[styles.aiLabelText, { color: colors.accent, fontFamily: fonts.bodyStrong }]}>
            Recipe guide
          </Text>
        </View>
        <RecipePressable
          onPress={onCancel}
          testID="recipe-preference-cancel"
          accessibilityRole="button"
          accessibilityLabel="Close recipe questions"
          hitSlop={10}
          style={styles.closeButton}
        >
          <FontAwesome name="close" size={18} color={colors.textMuted} />
        </RecipePressable>
      </View>

      <View style={styles.progressRow} accessibilityLabel="Question progress">
        {RECIPE_PREFERENCE_STEPS.map((step, index) => (
          <View
            key={step.key}
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

      <Text style={[styles.stepLabel, { color: colors.textMuted, fontFamily: fonts.body }]}>
        Step {stepIndex + 1} of {RECIPE_PREFERENCE_STEPS.length}
      </Text>
      <Text style={[styles.title, { color: colors.text, fontFamily: fonts.display }]}>
        {current.label}
      </Text>
      {current.helperText ? (
        <Text
          style={[
            styles.subtitle,
            { color: colors.textMuted, fontFamily: fonts.body },
          ]}
        >
          {current.helperText}
        </Text>
      ) : null}

      {current.freeText ? (
        <View>
          <TextInput
            value={occasion}
            onChangeText={setOccasion}
            testID="recipe-preference-occasion"
            placeholder={current.placeholder}
            placeholderTextColor={colors.textSubtle}
            multiline
            maxLength={160}
            textAlignVertical="top"
            style={[
              styles.textInput,
              {
                color: colors.text,
                backgroundColor: colors.surface,
                borderColor: colors.border,
                fontFamily: fonts.body,
              },
            ]}
          />
          <Text style={[styles.helperText, { color: colors.textSubtle, fontFamily: fonts.body }]}>
            Open-ended - leave blank and we will use what we know.
          </Text>
        </View>
      ) : (
        <View style={styles.options}>
          {current.options?.map((option, index) => {
            const selected = answers[current.key] === option;
            return (
              <RecipePressable
                key={option}
                onPress={() => selectOption(option)}
                testID={`recipe-preference-option-${current.key}-${index}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[
                  styles.option,
                  {
                    backgroundColor: selected
                      ? colors.accentSoft
                      : colors.surface,
                    borderColor: selected ? colors.accent : colors.border,
                  },
                ]}
              >
                <Text
                  style={{
                    color: selected ? colors.accent : colors.text,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 15,
                  }}
                >
                  {option}
                </Text>
                {selected ? (
                  <FontAwesome name="check" size={14} color={colors.accent} />
                ) : null}
              </RecipePressable>
            );
          })}
        </View>
      )}

      <View style={styles.actions}>
        <RecipePressable
          onPress={stepIndex > 0 ? () => setStepIndex((previous) => previous - 1) : onCancel}
          testID={stepIndex > 0 ? "recipe-preference-back" : "recipe-preference-cancel-footer"}
          accessibilityRole="button"
          style={[styles.secondaryButton, { borderColor: colors.border }]}
        >
          <Text style={{ color: colors.textMuted, fontFamily: fonts.bodyStrong }}>
            {stepIndex > 0 ? "Back" : "Cancel"}
          </Text>
        </RecipePressable>
        <RecipePressable
          onPress={skipQuestion}
          testID="recipe-preference-skip-question"
          accessibilityRole="button"
          style={styles.skipQuestionButton}
        >
          <Text style={{ color: colors.textMuted, fontFamily: fonts.bodyStrong }}>
            Skip this
          </Text>
        </RecipePressable>
        {current.freeText ? (
          <RecipePressable
            onPress={submitFreeText}
            testID="recipe-preference-next"
            accessibilityRole="button"
            style={[styles.primaryButton, { backgroundColor: colors.accent }]}
          >
            <Text style={{ color: colors.accentInk, fontFamily: fonts.bodyStrong }}>
              Generate recipes
            </Text>
          </RecipePressable>
        ) : null}
      </View>

      <RecipePressable
        onPress={() => onComplete(draftAnswers)}
        testID="recipe-preference-skip-flow"
        accessibilityRole="button"
        style={styles.skipFlowButton}
      >
        <Text style={{ color: colors.textMuted, fontFamily: fonts.body }}>
          Skip remaining questions and generate
        </Text>
      </RecipePressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 32,
    gap: 14,
  },
  headerRow: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  aiLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  aiLabelText: {
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  closeButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  progressRow: {
    flexDirection: "row",
    gap: 4,
    marginTop: 4,
  },
  progressSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  stepLabel: {
    fontSize: 12,
    marginTop: 8,
  },
  title: {
    fontSize: 26,
    lineHeight: 33,
    letterSpacing: -0.6,
    marginTop: -4,
  },
  subtitle: {
    fontSize: 13.5,
    lineHeight: 19,
    marginTop: -6,
  },
  options: {
    gap: 8,
    marginTop: 4,
  },
  option: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  textInput: {
    minHeight: 128,
    paddingHorizontal: 15,
    paddingVertical: 14,
    borderWidth: 1,
    borderRadius: 14,
    fontSize: 15,
    lineHeight: 21,
  },
  helperText: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 8,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  secondaryButton: {
    minHeight: 48,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  skipQuestionButton: {
    minHeight: 48,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButton: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  skipFlowButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
