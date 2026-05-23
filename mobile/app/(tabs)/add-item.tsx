import {
  StyleSheet,
  TextInput,
  ScrollView,
  Text,
  View,
  Pressable,
} from "react-native";
import { useEffect, useState } from "react";
import Slider from "@react-native-community/slider";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useRouter } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import SegmentedControl from "@/components/SegmentedControl";
import Field from "@/components/Field";
import { useTheme } from "@/hooks/useTheme";
import {
  FoodCategory,
  shelfLifeFor,
  useFoodCategories,
} from "@/hooks/useFoodCategories";
import { useAddItem } from "@/hooks/useAddItem";

type StorageLocation = "fridge" | "freezer" | "pantry";

const STORAGE_OPTIONS = ["Fridge", "Freezer", "Pantry"] as const;
const MIN_DAYS = 1;
// Slider tops out at 1 year. Shelf-stable items (canned goods up to 3 years per
// USDA) clamp here and the hint surfaces the real number in text.
const MAX_DAYS = 365;
const DEFAULT_DAYS = 7;

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

function recommendedStorages(cat: FoodCategory): StorageLocation[] {
  return (
    [
      ["fridge", cat.fridge_days] as const,
      ["freezer", cat.freezer_days] as const,
      ["pantry", cat.pantry_days] as const,
    ]
      .filter(([, d]) => d !== null)
      .map(([s]) => s)
  );
}

export default function AddItemScreen() {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  const { data: categories } = useFoodCategories();
  const addItem = useAddItem();

  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageLocation>("fridge");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("item");
  const [expDays, setExpDays] = useState(DEFAULT_DAYS);
  const [userEditedDate, setUserEditedDate] = useState(false);
  const [touched, setTouched] = useState({
    name: false,
    quantity: false,
    category: false,
  });

  const selectedCategory = categories?.find((c) => c.id === categoryId) ?? null;
  const storageLabel = storage.charAt(0).toUpperCase() + storage.slice(1);

  const trimmedName = name.trim();
  const parsedQuantity = parseFloat(quantity);
  const errors = {
    name: trimmedName.length === 0 ? "Name is required" : null,
    quantity:
      !Number.isFinite(parsedQuantity) || parsedQuantity <= 0
        ? "Quantity must be greater than 0"
        : null,
    category: categoryId === null ? "Pick a category" : null,
  };
  const isValid = !errors.name && !errors.quantity && !errors.category;

  const usdaSuggestion = shelfLifeFor(selectedCategory, storage);
  const storageNotRecommended =
    selectedCategory !== null && usdaSuggestion === null;

  useEffect(() => {
    if (usdaSuggestion === null) return;
    const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, usdaSuggestion));
    setExpDays(clamped);
    setUserEditedDate(false);
    // userEditedDate excluded from deps — this effect resets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, storage, categories, usdaSuggestion]);

  const handleStorageSelect = (option: string) => {
    setStorage(option.toLowerCase() as StorageLocation);
  };

  const handleSliderChange = (value: number) => {
    setExpDays(Math.round(value));
    if (!userEditedDate) setUserEditedDate(true);
  };

  const handleCategorySelect = (id: string) => {
    setCategoryId(id);
    setTouched((t) => ({ ...t, category: true }));
  };

  const resetForm = () => {
    setName("");
    setCategoryId(null);
    setStorage("fridge");
    setQuantity("1");
    setUnit("item");
    setExpDays(DEFAULT_DAYS);
    setUserEditedDate(false);
    setTouched({ name: false, quantity: false, category: false });
  };

  const handleSubmit = () => {
    if (addItem.isPending) return;
    if (!isValid) {
      setTouched({ name: true, quantity: true, category: true });
      return;
    }

    const expirationDate = new Date(Date.now() + expDays * 86400000)
      .toISOString()
      .slice(0, 10);

    const addedName = trimmedName;

    addItem.mutate(
      {
        name: trimmedName,
        category_id: categoryId,
        quantity: parsedQuantity,
        unit: unit.trim() || "item",
        expiration_date: expirationDate,
        storage_location: storage,
        notes: null,
      },
      {
        onSuccess: ({ id }) => {
          resetForm();
          Toast.show({
            type: "success",
            text1: `Added ${addedName}`,
            text2: "Tap to view in your inventory.",
          });
          router.push({
            pathname: "/(tabs)/inventory",
            params: { added: id },
          });
        },
        onError: () => {
          Toast.show({
            type: "error",
            text1: "Couldn't save",
            text2: "Check your connection and try again.",
          });
        },
      },
    );
  };

  const expirationHint = (() => {
    const dateText = `≈ ${formatExpirationDate(expDays)}`;
    if (userEditedDate || !selectedCategory) return dateText;
    if (usdaSuggestion === null) return dateText;
    if (usdaSuggestion > MAX_DAYS) {
      return `${dateText} · USDA: ${formatShelfLife(usdaSuggestion)} for ${selectedCategory.name} (capped)`;
    }
    return `${dateText} · USDA average for ${selectedCategory.name} in ${storage}`;
  })();

  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        {
          backgroundColor: colors.bg,
          paddingTop: insets.top + 16,
          paddingBottom: tabBarHeight + 24,
        },
      ]}
    >
      <Text
        style={[
          styles.title,
          { color: colors.text, fontFamily: fonts.display },
        ]}
      >
        Add Item
      </Text>

      <View style={styles.fields}>
        <Field
          label="Item name"
          error={touched.name ? errors.name ?? undefined : undefined}
        >
          <TextInput
            placeholder="What are you adding?"
            placeholderTextColor={colors.textSubtle}
            value={name}
            onChangeText={setName}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            style={[
              styles.input,
              {
                borderColor: touched.name && errors.name ? colors.crit : colors.border,
                backgroundColor: colors.surface,
                color: colors.text,
              },
            ]}
          />
        </Field>

        <Field
          label="Category"
          error={touched.category ? errors.category ?? undefined : undefined}
        >
          <View style={styles.chipRow}>
            {categories?.map((c) => {
              const isSelected = c.id === categoryId;
              return (
                <Pressable
                  key={c.id}
                  onPress={() => handleCategorySelect(c.id)}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 100,
                    backgroundColor: isSelected
                      ? colors.accent
                      : colors.surfaceAlt,
                  }}
                >
                  <Text
                    style={{
                      color: isSelected ? colors.accentInk : colors.textMuted,
                      fontWeight: "600",
                      fontSize: 12.5,
                      letterSpacing: -0.1,
                    }}
                  >
                    {c.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Field>

        <View style={styles.row}>
          <View style={styles.flex1}>
            <Field
              label="Quantity"
              error={touched.quantity ? errors.quantity ?? undefined : undefined}
            >
              <TextInput
                keyboardType="numeric"
                value={quantity}
                onChangeText={setQuantity}
                onBlur={() => setTouched((t) => ({ ...t, quantity: true }))}
                style={[
                  styles.input,
                  {
                    borderColor:
                      touched.quantity && errors.quantity
                        ? colors.crit
                        : colors.border,
                    backgroundColor: colors.surface,
                    color: colors.text,
                  },
                ]}
              />
            </Field>
          </View>
          <View style={styles.flex1}>
            <Field label="Unit">
              <TextInput
                value={unit}
                onChangeText={setUnit}
                style={[
                  styles.input,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.surface,
                    color: colors.text,
                  },
                ]}
              />
            </Field>
          </View>
        </View>

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
              {
                backgroundColor: colors.surfaceAlt,
                borderColor: colors.warn,
              },
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
              isn't recommended in the {storage}. USDA suggests{" "}
              {recommendedStorages(selectedCategory).join(" or ")} instead.
            </Text>
          </View>
        ) : null}

        <Field label="Expires in" hint={expirationHint}>
          <View
            style={[
              styles.sliderRow,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
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
              opacity: !isValid || addItem.isPending ? 0.5 : 1,
            },
          ]}
          onPress={handleSubmit}
        >
          <Text style={[styles.submitLabel, { color: colors.accentInk }]}>
            {addItem.isPending ? "Adding…" : "Add to inventory"}
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
    paddingTop: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 16,
    letterSpacing: -0.4,
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
  row: {
    flexDirection: "row",
    gap: 12,
  },
  flex1: {
    flex: 1,
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
