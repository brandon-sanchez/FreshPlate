import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import CookAddItem from "@/components/cook-add-item";
import CookChecklistCard from "@/components/cook-checklist-card";
import ErrorState from "@/components/ErrorState";
import FoodPhoto from "@/components/food-photo";
import LoadingState from "@/components/LoadingState";
import { RecipePressable } from "@/components/recipe-motion";
import { card } from "@/constants/theme";
import { useCookChecklist } from "@/hooks/useCookChecklist";
import { useScrollAboveKeyboard } from "@/hooks/useScrollAboveKeyboard";
import { useTheme } from "@/hooks/useTheme";
import type { UntrackedIngredient } from "@/types/cook";
import type { RecipeIngredient, RecipeSuggestion } from "@/types/recipes";

const FOOTER_TOP_PADDING = 16;
const CONFIRM_BUTTON_HEIGHT = 54;
const FOOTER_BOTTOM_GAP = 14;
const KEYBOARD_GAP = 16;
const DOUBLE_TAP_GUARD_MS = 700;

type CookChecklistProps = {
  /** Called by "Back", which returns to the recipe without changing anything. */
  onBack: () => void;
  /** Receives the cooked recipe once the kitchen is updated, just before the active cook clears. */
  onConfirmed: (recipe: RecipeSuggestion) => void;
};

/**
 * The done-cooking checklist for the active cook: one card per tracked food,
 * "Add item", the untracked ingredients greyed, and one confirm button that
 * deducts everything. The button stays disabled until the checklist has
 * loaded and been on screen for a moment. Reads and confirms through
 * {@link useCookChecklist}.
 */
export default function CookChecklist({ onBack, onConfirmed }: CookChecklistProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const checklist = useCookChecklist({ onConfirmed });
  const scrollRef = useRef<ScrollView>(null);
  const addItemRef = useRef<View>(null);
  const keyboard = useScrollAboveKeyboard(scrollRef, addItemRef, KEYBOARD_GAP);
  const footerPadding = insets.bottom + FOOTER_BOTTOM_GAP;
  const ingredients = checklist.cook?.recipe.ingredients ?? [];
  const listed = new Set(checklist.lines.map((line) => line.foodId));
  const settled = useSettled(checklist.status === "ready");
  const canConfirm = settled && !checklist.confirming;

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <ScrollView
        ref={scrollRef}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingBottom: footerPadding + CONFIRM_BUTTON_HEIGHT + FOOTER_TOP_PADDING + 24,
        }}
      >
        <View style={styles.topBar}>
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back to the recipe"
            hitSlop={8}
            style={[
              styles.back,
              { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
            ]}
          >
            <Feather name="chevron-left" size={14} color={colors.text} />
            <Text style={[styles.backLabel, { color: colors.text, fontFamily: fonts.bodyStrong }]}>
              Back
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text, fontFamily: fonts.display }]}>
            Cook it
          </Text>
          <Text
            numberOfLines={2}
            style={[styles.subtitle, { color: colors.textMuted, fontFamily: fonts.body }]}
          >
            {checklist.cook?.recipe.title}
          </Text>
        </View>
        <Text style={[styles.helper, { color: colors.textMuted, fontFamily: fonts.body }]}>
          Confirm what you used — we&apos;ll update your fridge.
        </Text>
        {checklist.status === "loading" ? (
          <LoadingState label="Checking your kitchen..." />
        ) : checklist.status === "error" ? (
          <ErrorState
            title="Couldn't check your kitchen"
            message="Check your connection and try again."
            onRetry={checklist.retry}
          />
        ) : (
          <View style={styles.list}>
            {checklist.stockChanged ? (
              <View
                accessible
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[styles.changed, { borderColor: colors.crit, backgroundColor: colors.surface }]}
              >
                <Feather name="alert-circle" size={16} color={colors.crit} />
                <Text style={[styles.changedText, { color: colors.text, fontFamily: fonts.body }]}>
                  Someone used some of these since you opened this. Check the marked
                  items, then confirm again.
                </Text>
              </View>
            ) : null}
            {checklist.lines.map((line) => (
              <CookChecklistCard
                key={line.foodId}
                line={line}
                onChangeAmount={(amount) => checklist.setAmount(line.foodId, amount)}
                onRemove={
                  line.planLines.length === 0
                    ? () => checklist.removeFood(line.foodId)
                    : undefined
                }
              />
            ))}
            <View ref={addItemRef}>
              <CookAddItem
                foods={checklist.addable}
                listed={listed}
                onAdd={checklist.addFood}
                onInputFocus={keyboard.onFocus}
                onInputBlur={keyboard.onBlur}
              />
            </View>
            {checklist.untracked.map((item) => (
              <UntrackedCard
                key={item.line}
                ingredient={ingredients[item.line]}
                name={item.name}
                reason={item.reason}
              />
            ))}
          </View>
        )}
      </ScrollView>
      <View
        style={[
          styles.footer,
          {
            paddingBottom: footerPadding,
            backgroundColor: colors.bg,
            borderColor: colors.border,
          },
        ]}
      >
        <RecipePressable
          disabled={!canConfirm}
          onPress={() => void checklist.confirm()}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canConfirm }}
          testID="cook-confirm"
          style={[
            styles.confirm,
            {
              backgroundColor: colors.accent,
              opacity: canConfirm ? 1 : 0.6,
            },
          ]}
        >
          <Feather name="check" size={18} color={colors.accentInk} />
          <Text style={[styles.confirmLabel, { color: colors.accentInk, fontFamily: fonts.bodyStrong }]}>
            Cooked it · deduct from fridge
          </Text>
        </RecipePressable>
      </View>
    </View>
  );
}

function useSettled(ready: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setSettled(true), DOUBLE_TAP_GUARD_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  return ready && settled;
}

function UntrackedCard({
  ingredient,
  name,
  reason,
}: {
  ingredient: RecipeIngredient | undefined;
  name: string;
  reason: UntrackedIngredient["reason"];
}) {
  const { colors, fonts } = useTheme();
  return (
    <View
      testID="cook-untracked"
      style={[styles.untracked, card, { backgroundColor: colors.surface }]}
    >
      <FoodPhoto foodId={ingredient?.inventory_item_id ?? null} size={40} enabled />
      <View style={styles.untrackedCopy}>
        <Text style={[styles.untrackedName, { color: colors.textMuted, fontFamily: fonts.bodyStrong }]}>
          {name}
        </Text>
        <Text style={[styles.untrackedNote, { color: colors.textSubtle, fontFamily: fonts.body }]}>
          {reason === "basic" ? "Not tracked - no deduction" : "None left - no deduction"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topBar: { paddingHorizontal: 20, paddingBottom: 6 },
  back: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 5,
    paddingLeft: 8,
    paddingRight: 12,
    marginBottom: 8,
    borderRadius: 100,
    borderWidth: 1,
  },
  backLabel: { fontSize: 12.5 },
  title: { fontSize: 28, lineHeight: 31, letterSpacing: -0.56 },
  subtitle: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  helper: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 14 },
  list: { paddingHorizontal: 16, gap: 8 },
  changed: {
    flexDirection: "row",
    gap: 10,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
  changedText: { flex: 1, fontSize: 13, lineHeight: 18 },
  untracked: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    opacity: 0.6,
  },
  untrackedCopy: { flex: 1, gap: 2 },
  untrackedName: { fontSize: 14, lineHeight: 19 },
  untrackedNote: { fontSize: 12, lineHeight: 16 },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: FOOTER_TOP_PADDING,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  confirm: {
    minHeight: CONFIRM_BUTTON_HEIGHT,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  confirmLabel: { fontSize: 16 },
});
