import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Slider from "@react-native-community/slider";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import AmountField from "@/components/AmountField";
import Chip from "@/components/Chip";
import Field from "@/components/Field";
import SegmentedControl from "@/components/SegmentedControl";
import type { AddItemInput } from "@/hooks/useAddItem";
import { useTheme } from "@/hooks/useTheme";
import {
  FoodCategory,
  shelfLifeFor,
  StorageLocation,
} from "@/hooks/useFoodCategories";
import { useHouseholdFoods } from "@/hooks/useHouseholdFoods";
import { defaultStorageForCategory } from "@/lib/categoryMatch";
import { findFood, KnownFood, suggestFoods } from "@/lib/knownFood";
import {
  AmountDraft,
  draftFromLastLot,
  fitDraftToFood,
  resolveAmount,
} from "@/lib/lotAmount";

const STORAGE_OPTIONS = ["Fridge", "Freezer", "Pantry"] as const;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const ONE_EACH: AmountDraft = { kind: "count", label: "each", count: 1 };

/**
 * Where the expiry slider's value came from. Only `"usda"` follows the
 * category and storage; the last add's shelf life and a dragged value stay put.
 */
type ExpirySource = "usda" | "lastAdd" | "user";

/** Starting values for the form; anything left out starts blank or at its default. */
export type ItemFormDefaults = {
  /** The food name as it should appear in the name field. */
  name?: string;
  /** The preselected category, or `null` for none. */
  categoryId?: string | null;
  /** Defaults to the fridge. */
  storage?: StorageLocation;
  /** Defaults to a count of 1 each. */
  amount?: AmountDraft;
  /** Days until expiry; left out, the slider follows the USDA default for the category. */
  expDays?: number;
  /**
   * Marks the category as a guess, such as one matched from a barcode. The
   * form shows it outlined and blocks submit until a category chip is tapped,
   * unless the name matches a known food, whose own category then shows.
   */
  confirmCategory?: boolean;
};

type ItemFormProps = {
  /** The category chips; `undefined` while they load. */
  categories: FoodCategory[] | undefined;
  /** Read on mount only; remount the form with a new `key` to start over. */
  defaults?: ItemFormDefaults;
  /** Text of the submit button. */
  submitLabel: string;
  /** Text of the submit button while `isSubmitting`; defaults to "Saving…". */
  submittingLabel?: string;
  /** Dims the submit button and ignores presses while an add is in flight. */
  isSubmitting?: boolean;
  /** Receives a valid add; the caller supplies its notes. */
  onSubmit: (input: Omit<AddItemInput, "notes">) => void;
  /** Content shown above the fields, inside the scroll view. */
  header?: ReactNode;
  /** Extra style for the scroll view's content, such as safe-area padding. */
  contentContainerStyle?: object;
};

function formatExpirationDate(daysFromNow: number): string {
  const date = new Date(Date.now() + daysFromNow * 86400000);
  const options: Intl.DateTimeFormatOptions =
    daysFromNow > 60
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" };
  return date.toLocaleDateString(undefined, options);
}

function formatShelfLife(days: number): string {
  if (days < 30) return `${days}d`;
  if (days < 365) return `≈ ${Math.round(days / 30)}mo`;
  const years = days / 365;
  if (years < 2) return `≈ ${Math.round(years * 12)}mo`;
  return `≈ ${Math.round(years)}yr`;
}

function clampDays(days: number): number {
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, days));
}

function recommendedStorages(cat: FoodCategory): StorageLocation[] {
  return [
    ["fridge", cat.fridge_days] as const,
    ["freezer", cat.freezer_days] as const,
    ["pantry", cat.pantry_days] as const,
  ]
    .filter(([, d]) => d !== null)
    .map(([s]) => s);
}

/**
 * The add-food form shared by manual entry and barcode review. It suggests the
 * household's foods under the name field, pre-fills a picked food from its last
 * lot, and limits the unit chips to the stock base of the food the name
 * matches, so the submitted amount always fits that food. Reads household
 * foods through {@link useHouseholdFoods}.
 */
function ItemForm({
  categories,
  defaults,
  submitLabel,
  submittingLabel,
  isSubmitting = false,
  onSubmit,
  header,
  contentContainerStyle,
}: ItemFormProps) {
  const { colors, fonts } = useTheme();

  const [name, setName] = useState(defaults?.name ?? "");
  const [chosenCategoryId, setCategoryId] = useState<string | null>(
    defaults?.categoryId ?? null,
  );
  const [storage, setStorage] = useState<StorageLocation>(
    defaults?.storage ?? "fridge",
  );
  const [rawDraft, setRawDraft] = useState<AmountDraft>(
    defaults?.amount ?? ONE_EACH,
  );
  const [expDays, setExpDays] = useState(defaults?.expDays ?? 7);
  const [expirySource, setExpirySource] = useState<ExpirySource>("usda");
  const [categoryConfirmed, setCategoryConfirmed] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [touched, setTouched] = useState({
    name: false,
    amount: false,
    category: false,
  });
  const nameInput = useRef<TextInput>(null);

  const { data: foods = [] } = useHouseholdFoods();
  const food = useMemo(() => findFood(foods, name), [foods, name]);
  const suggestions = useMemo(() => suggestFoods(foods, name), [foods, name]);
  const showSuggestions =
    suggestions.length > 0 && (nameFocused || name.trim() === "");

  // Fitting is derived rather than stored, so typing past a known name
  // ("Egg" to "Eggplant") gives the user's own amount back.
  const draft = fitDraftToFood(rawDraft, food);

  // A known food keeps its category in add_lot, so a barcode's guess gives way
  // to it and needs no confirmation.
  const guessingCategory = !!defaults?.confirmCategory && !categoryConfirmed;
  const categoryId =
    guessingCategory && food ? food.categoryId : chosenCategoryId;
  const awaitingConfirmation = guessingCategory && food === null;

  const selectedCategory = categories?.find((c) => c.id === categoryId) ?? null;
  const storageLabel = storage.charAt(0).toUpperCase() + storage.slice(1);

  const trimmedName = name.trim();
  const resolved = resolveAmount(draft, food);
  const errors = {
    name: trimmedName.length === 0 ? "Name is required" : null,
    amount: resolved.ok ? null : resolved.error,
    category:
      categoryId === null
        ? "Pick a category"
        : awaitingConfirmation
          ? "Confirm the category"
          : null,
  };
  const isValid = !errors.name && !errors.amount && !errors.category;

  const usdaSuggestion = shelfLifeFor(selectedCategory, storage);
  const storageNotRecommended =
    selectedCategory !== null && usdaSuggestion === null;

  useEffect(() => {
    if (usdaSuggestion === null) return;
    if (expirySource !== "usda") return;
    setExpDays(clampDays(usdaSuggestion));
  }, [categoryId, storage, categories, usdaSuggestion, expirySource]);

  const handleStorageSelect = (option: string) => {
    setStorage(option.toLowerCase() as StorageLocation);
    if (expirySource === "lastAdd") setExpirySource("usda");
  };

  const handleSliderChange = (value: number) => {
    setExpDays(Math.round(value));
    setExpirySource("user");
  };

  const handleCategorySelect = (id: string) => {
    setCategoryId(id);
    setCategoryConfirmed(true);
    setTouched((t) => ({ ...t, category: true }));
  };

  const handlePickSuggestion = (picked: KnownFood) => {
    const category =
      categories?.find((c) => c.id === picked.categoryId) ?? null;
    setName(picked.name);
    setCategoryId(picked.categoryId);
    setCategoryConfirmed(true);
    setStorage(picked.lastLot?.storage ?? defaultStorageForCategory(category));
    setRawDraft(draftFromLastLot(picked));
    const remembered = picked.lastLot?.shelfLifeDays ?? null;
    if (remembered !== null) {
      setExpDays(clampDays(remembered));
      setExpirySource("lastAdd");
    } else {
      setExpirySource("usda");
    }
    nameInput.current?.blur();
  };

  const handleSubmit = () => {
    if (isSubmitting) return;
    if (!isValid || !resolved.ok) {
      setTouched({ name: true, amount: true, category: true });
      return;
    }
    /* Local-calendar math, not UTC slicing: `.toISOString().slice(0,10)` shifts
     * to UTC and rounds to next-day for evening adds in negative-UTC zones. */
    const now = new Date();
    const target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + expDays,
    );
    const expirationDate = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
    onSubmit({
      name: trimmedName,
      category_id: categoryId,
      amount: resolved.amount,
      expiration_date: expirationDate,
      storage_location: storage,
    });
  };

  const expirationHint = (() => {
    const dateText = `≈ ${formatExpirationDate(expDays)}`;
    if (expirySource === "lastAdd")
      return `${dateText} · Based on the last one you added`;
    if (expirySource === "user" || !selectedCategory) return dateText;
    if (usdaSuggestion === null) return dateText;
    if (usdaSuggestion > MAX_DAYS) {
      return `${dateText} · USDA: ${formatShelfLife(usdaSuggestion)} for ${selectedCategory.name} (capped)`;
    }
    return `${dateText} · USDA average for ${selectedCategory.name} in ${storage}`;
  })();

  return (
    <ScrollView
      contentContainerStyle={[styles.container, contentContainerStyle]}
      // Lets a suggestion tap land while the name field still has the keyboard up.
      keyboardShouldPersistTaps="handled"
    >
      {header}
      <View style={styles.fields}>
        <Field
          label="Item name"
          error={touched.name ? (errors.name ?? undefined) : undefined}
        >
          <TextInput
            ref={nameInput}
            accessibilityLabel="Item name"
            placeholder="What are you adding?"
            placeholderTextColor={colors.textSubtle}
            value={name}
            // Mirrors the 80-character CHECK on foods.name.
            maxLength={80}
            onChangeText={setName}
            onFocus={() => setNameFocused(true)}
            onBlur={() => {
              setNameFocused(false);
              setTouched((t) => ({ ...t, name: true }));
            }}
            style={[
              styles.input,
              {
                borderColor:
                  touched.name && errors.name ? colors.crit : colors.border,
                backgroundColor: colors.surface,
                color: colors.text,
              },
            ]}
          />
          {showSuggestions ? (
            <View style={[styles.chipRow, styles.suggestions]}>
              {suggestions.map((suggestion) => (
                <Chip
                  key={suggestion.id}
                  label={suggestion.name}
                  onPress={() => handlePickSuggestion(suggestion)}
                />
              ))}
            </View>
          ) : null}
        </Field>

        <Field
          label="Category"
          hint={
            awaitingConfirmation && categoryId !== null
              ? "From the barcode. Tap to confirm."
              : undefined
          }
          error={touched.category ? (errors.category ?? undefined) : undefined}
        >
          <View style={styles.chipRow}>
            {categories?.map((c) => (
              <Chip
                key={c.id}
                label={c.name}
                state={
                  c.id !== categoryId
                    ? "off"
                    : awaitingConfirmation
                      ? "guessed"
                      : "on"
                }
                onPress={() => handleCategorySelect(c.id)}
              />
            ))}
          </View>
        </Field>

        <AmountField
          value={draft}
          onChange={setRawDraft}
          food={food}
          error={touched.amount ? (errors.amount ?? undefined) : undefined}
        />

        <Field label="Storage">
          <SegmentedControl
            options={[...STORAGE_OPTIONS]}
            selected={storageLabel}
            onSelect={handleStorageSelect}
          />
        </Field>

        {storageNotRecommended && selectedCategory ? (
          <View
            style={[
              styles.warningRow,
              { backgroundColor: colors.surfaceAlt, borderColor: colors.warn },
            ]}
          >
            <FontAwesome
              name="exclamation-triangle"
              size={13}
              color={colors.warn}
            />
            <Text
              style={{
                flex: 1,
                fontFamily: fonts.body,
                fontSize: 12.5,
                color: colors.text,
                lineHeight: 17,
              }}
            >
              <Text style={{ fontFamily: fonts.bodyStrong }}>
                {selectedCategory.name}
              </Text>{" "}
              isn&apos;t recommended in the {storage}. USDA suggests{" "}
              {recommendedStorages(selectedCategory).join(" or ")} instead.
            </Text>
          </View>
        ) : null}

        <Field label="Expires in" hint={expirationHint}>
          <View
            style={[
              styles.sliderRow,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Slider
              style={styles.slider}
              minimumValue={MIN_DAYS}
              maximumValue={MAX_DAYS}
              step={1}
              value={expDays}
              onValueChange={handleSliderChange}
              minimumTrackTintColor={colors.accent}
              maximumTrackTintColor={colors.surfaceAlt}
              thumbTintColor={colors.accent}
            />
            <Text style={[styles.dayCount, { color: colors.text }]}>
              {expDays}d
            </Text>
          </View>
        </Field>

        <Pressable
          style={[
            styles.submit,
            {
              backgroundColor: colors.accent,
              opacity: !isValid || isSubmitting ? 0.5 : 1,
            },
          ]}
          onPress={handleSubmit}
        >
          <Text style={[styles.submitLabel, { color: colors.accentInk }]}>
            {isSubmitting ? (submittingLabel ?? "Saving…") : submitLabel}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  fields: {
    gap: 16,
  },
  input: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 15,
    justifyContent: "center",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  suggestions: {
    marginTop: 10,
  },
  submit: {
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  submitLabel: {
    fontSize: 16,
    fontWeight: "600",
  },
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  slider: {
    flex: 1,
  },
  dayCount: {
    fontSize: 14,
    fontWeight: "600",
    minWidth: 46,
    textAlign: "right",
  },
  warningRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
});

export default ItemForm;
