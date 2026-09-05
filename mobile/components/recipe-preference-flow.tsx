import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import RecipeActionButton from "@/components/recipe-action-button";
import RecipeContextComposer from "@/components/recipe-context-composer";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipePreferenceKey, RecipePreferences } from "@/types/recipes";

type PreferenceStep = {
  key: RecipePreferenceKey;
  label: string;
  helperText: string;
} & (
  | { kind: "choice"; options: readonly string[] }
  | { kind: "context"; placeholder: string }
);

export const RECIPE_PREFERENCE_STEPS: readonly PreferenceStep[] = [
  {
    key: "meal",
    kind: "choice",
    label: "Which meal?",
    helperText: "Start broad. We'll find something that fits.",
    options: ["Breakfast", "Lunch", "Dinner", "Snack", "Dessert"],
  },
  {
    key: "time",
    kind: "choice",
    label: "How much time?",
    helperText: "A quick bite or a little time in the kitchen?",
    options: ["<15 min", "<30 min", "<60 min", "I have all night"],
  },
  {
    key: "mood",
    kind: "choice",
    label: "What mood?",
    helperText: "Go with whatever sounds good right now.",
    options: ["Comfort", "Light & clean", "Adventurous", "Fancy"],
  },
  {
    key: "cuisine",
    kind: "choice",
    label: "Cuisine vibe?",
    helperText: "Pick a favorite, or leave room for a surprise.",
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
    kind: "choice",
    label: "Any diet goals?",
    helperText: "One more way to make these recipes yours.",
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
    kind: "context",
    label: "Anything else?",
    helperText: "An occasion, a craving, or who you're cooking for.",
    placeholder: "Date night, feeding a toddler, using up tomatoes...",
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
  const reducedMotion = useReducedMotion();
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<RecipePreferences>(() => ({
    ...initialPreferences,
  }));
  const [occasion, setOccasion] = useState(initialPreferences.occasion ?? "");
  const [transitioning, setTransitioning] = useState(false);
  const transitionLocked = useRef(false);
  const completed = useRef(false);
  const activeStep = useRef(0);
  const contentProgress = useRef(new Animated.Value(1)).current;
  const transition = useRef<Animated.CompositeAnimation | null>(null);
  const scroll = useRef<ScrollView>(null);
  const current = RECIPE_PREFERENCE_STEPS[stepIndex];

  useEffect(
    () => () => {
      transition.current?.stop();
    },
    [],
  );

  useEffect(() => {
    if (!reducedMotion || !transitionLocked.current) return;
    transition.current?.stop();
    contentProgress.setValue(1);
    setStepIndex(activeStep.current);
    setTransitioning(false);
    transitionLocked.current = false;
  }, [contentProgress, reducedMotion]);

  const draftAnswers = useMemo(() => {
    const trimmed = occasion.trim();
    return trimmed
      ? { ...answers, occasion: trimmed }
      : withoutPreference(answers, "occasion");
  }, [answers, occasion]);

  const finish = (next: RecipePreferences) => {
    if (completed.current || transitionLocked.current) return;
    completed.current = true;
    Keyboard.dismiss();
    onComplete(next);
  };

  const moveTo = (nextIndex: number) => {
    if (
      transitionLocked.current ||
      activeStep.current !== stepIndex ||
      completed.current
    )
      return;
    transitionLocked.current = true;
    activeStep.current = nextIndex;
    if (reducedMotion) {
      setStepIndex(nextIndex);
      scroll.current?.scrollTo({ y: 0, animated: false });
      transitionLocked.current = false;
      return;
    }
    setTransitioning(true);
    transition.current = Animated.sequence([
      Animated.delay(130),
      Animated.timing(contentProgress, {
        toValue: 0,
        duration: 120,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    transition.current.start(({ finished }) => {
      if (!finished) return;
      setStepIndex(nextIndex);
      scroll.current?.scrollTo({ y: 0, animated: false });
      transition.current = Animated.timing(contentProgress, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      transition.current.start(({ finished: entered }) => {
        if (!entered) return;
        transitionLocked.current = false;
        setTransitioning(false);
      });
    });
  };

  const selectOption = (value: string) => {
    if (
      transitionLocked.current ||
      activeStep.current !== stepIndex ||
      completed.current
    )
      return;
    setAnswers({ ...answers, [current.key]: value });
    moveTo(stepIndex + 1);
  };

  const skipQuestion = () => {
    if (transitionLocked.current || activeStep.current !== stepIndex) return;
    const next = withoutPreference(draftAnswers, current.key);
    setAnswers(next);
    if (current.kind === "context") {
      setOccasion("");
      finish(next);
    } else moveTo(stepIndex + 1);
  };

  const cancel = () => {
    if (completed.current) return;
    completed.current = true;
    transition.current?.stop();
    Keyboard.dismiss();
    onCancel();
  };

  const previousAnswers = RECIPE_PREFERENCE_STEPS.slice(0, stepIndex)
    .map((step) => answers[step.key])
    .filter(Boolean)
    .join(" · ");

  return (
    <ScrollView
      ref={scroll}
      testID="recipe-preference-flow"
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <View style={styles.headerRow}>
        <View style={styles.guideLabel}>
          <Feather name="sliders" size={15} color={colors.accent} />
          <Text
            style={[
              styles.caption,
              { color: colors.accent, fontFamily: fonts.bodyStrong },
            ]}
          >
            A little more you
          </Text>
        </View>
        <RecipePressable
          onPress={cancel}
          testID="recipe-preference-cancel"
          accessibilityRole="button"
          accessibilityLabel="Close recipe questions"
          style={[styles.closeButton, { backgroundColor: colors.surfaceAlt }]}
        >
          <Feather name="x" size={18} color={colors.textMuted} />
        </RecipePressable>
      </View>
      <View
        style={styles.progressRow}
        accessibilityRole="progressbar"
        accessibilityValue={{
          min: 1,
          max: RECIPE_PREFERENCE_STEPS.length,
          now: stepIndex + 1,
        }}
        accessibilityLabel="Recipe questions"
      >
        {RECIPE_PREFERENCE_STEPS.map((step, index) => (
          <View
            key={step.key}
            style={[
              styles.progressSegment,
              {
                backgroundColor:
                  index <= stepIndex ? colors.accent : colors.border,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.stepRow}>
        <Text
          style={[
            styles.caption,
            { color: colors.textMuted, fontFamily: fonts.body },
          ]}
        >
          Step {stepIndex + 1} of {RECIPE_PREFERENCE_STEPS.length}
        </Text>
        <Text
          style={[
            styles.caption,
            { color: colors.textMuted, fontFamily: fonts.body },
          ]}
        >
          For this session
        </Text>
      </View>
      <Animated.View
        style={{
          opacity: contentProgress,
          transform: [
            {
              translateY: contentProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [12, 0],
              }),
            },
          ],
        }}
      >
        <View style={styles.questionHeader}>
          <Text
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            style={[
              styles.title,
              { color: colors.text, fontFamily: fonts.display },
            ]}
          >
            {current.label}
          </Text>
          <Text
            style={[
              styles.subtitle,
              { color: colors.textMuted, fontFamily: fonts.body },
            ]}
          >
            {current.helperText}
          </Text>
        </View>
        {current.kind === "context" ? (
          <View style={styles.composerSection}>
            {previousAnswers ? (
              <Text
                style={[
                  styles.answerSummary,
                  { color: colors.textMuted, fontFamily: fonts.body },
                ]}
              >
                {previousAnswers}
              </Text>
            ) : null}
            <RecipeContextComposer
              value={occasion}
              onChangeText={setOccasion}
              onSubmit={() => finish(draftAnswers)}
              testID="recipe-preference-occasion"
              placeholder={current.placeholder}
            />
            <RecipeActionButton
              label={
                occasion.trim()
                  ? "Generate recipes"
                  : "Generate with these answers"
              }
              onPress={() => finish(draftAnswers)}
              testID="recipe-preference-next"
            />
          </View>
        ) : (
          <View
            style={styles.options}
            accessibilityRole="radiogroup"
            accessibilityLabel={current.label}
          >
            {current.options.map((option, index) => {
              const selected = answers[current.key] === option;
              return (
                <RecipePressable
                  key={`${current.key}-${option}`}
                  onPress={() => selectOption(option)}
                  disabled={transitioning}
                  testID={`recipe-preference-option-${current.key}-${index}`}
                  accessibilityRole="radio"
                  accessibilityLabel={option}
                  accessibilityHint="Selects this answer and moves to the next question"
                  accessibilityState={{
                    checked: selected,
                    disabled: transitioning,
                  }}
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
                    style={[
                      styles.optionLabel,
                      {
                        color: selected ? colors.accent : colors.text,
                        fontFamily: fonts.bodyStrong,
                      },
                    ]}
                  >
                    {option}
                  </Text>
                  <View
                    style={[
                      styles.radio,
                      {
                        borderColor: selected ? colors.accent : colors.border,
                        backgroundColor: selected
                          ? colors.accent
                          : "transparent",
                      },
                    ]}
                  >
                    {selected ? (
                      <View
                        style={[
                          styles.radioDot,
                          { backgroundColor: colors.accentInk },
                        ]}
                      />
                    ) : null}
                  </View>
                </RecipePressable>
              );
            })}
          </View>
        )}
      </Animated.View>
      <View style={styles.actions}>
        <RecipePressable
          onPress={stepIndex > 0 ? () => moveTo(stepIndex - 1) : cancel}
          disabled={transitioning}
          testID={
            stepIndex > 0
              ? "recipe-preference-back"
              : "recipe-preference-cancel-footer"
          }
          accessibilityRole="button"
          style={styles.quietButton}
        >
          <Feather name="arrow-left" size={16} color={colors.textMuted} />
          <Text
            style={[
              styles.actionText,
              { color: colors.textMuted, fontFamily: fonts.bodyStrong },
            ]}
          >
            {stepIndex > 0 ? "Back" : "Cancel"}
          </Text>
        </RecipePressable>
        <RecipePressable
          onPress={skipQuestion}
          disabled={transitioning}
          testID="recipe-preference-skip-question"
          accessibilityRole="button"
          style={styles.quietButton}
        >
          <Text
            style={[
              styles.actionText,
              { color: colors.textMuted, fontFamily: fonts.bodyStrong },
            ]}
          >
            Skip this
          </Text>
          <Feather name="arrow-right" size={16} color={colors.textMuted} />
        </RecipePressable>
      </View>
      {current.kind === "choice" ? (
        <RecipePressable
          onPress={() => finish(draftAnswers)}
          disabled={transitioning}
          testID="recipe-preference-skip-flow"
          accessibilityRole="button"
          style={[styles.skipFlowButton, { borderTopColor: colors.border }]}
        >
          <Text
            style={[
              styles.actionText,
              { color: colors.textMuted, fontFamily: fonts.body },
            ]}
          >
            Skip remaining questions and generate
          </Text>
        </RecipePressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 4, paddingBottom: 28 },
  headerRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  guideLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  caption: { fontSize: 12, lineHeight: 18 },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  progressRow: { flexDirection: "row", gap: 6 },
  progressSegment: { flex: 1, height: 3, borderRadius: 2 },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  questionHeader: { marginTop: 24, marginBottom: 24 },
  title: { fontSize: 32, lineHeight: 39, letterSpacing: -0.8 },
  subtitle: { fontSize: 14, lineHeight: 21, marginTop: 8 },
  options: { gap: 8 },
  option: {
    minHeight: 60,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderWidth: 1,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  optionLabel: { flex: 1, fontSize: 15, lineHeight: 22 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 6, height: 6, borderRadius: 3 },
  composerSection: { gap: 20 },
  answerSummary: { fontSize: 13, lineHeight: 21 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
  },
  quietButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 4,
  },
  actionText: { fontSize: 13, lineHeight: 20, textAlign: "center" },
  skipFlowButton: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 12,
  },
});
