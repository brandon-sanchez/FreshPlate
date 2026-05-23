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
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import SegmentedControl from "@/components/SegmentedControl";
import Field from "@/components/Field";
import { useTheme } from "@/hooks/useTheme";
import { useFoodCategories } from "@/hooks/useFoodCategories";
import { useAddItem } from "@/hooks/useAddItem";

type StorageLocation = "fridge" | "freezer" | "pantry";

const STORAGE_OPTIONS = ["Fridge", "Freezer", "Pantry"] as const;
const MIN_DAYS = 1;
const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;

function formatExpirationDate(daysFromNow: number): string {
  const date = new Date(Date.now() + daysFromNow * 86400000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AddItemScreen() {
  const { colors, fonts } = useTheme();
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

  useEffect(() => {
    // Auto-suggest expDays from category's default_shelf_life_days, but only if user hasn't manually edited the date.
    if (userEditedDate) return;
    if (!selectedCategory || selectedCategory.default_shelf_life_days == null)
      return;

    const suggestedDays = Math.round(selectedCategory.default_shelf_life_days);
    const clampedDays = Math.min(MAX_DAYS, Math.max(MIN_DAYS, suggestedDays));
    setExpDays(clampedDays);
  }, [categoryId, categories, userEditedDate]);

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
        onSuccess: () => {
          resetForm();
          Toast.show({
            type: "success",
            text1: "Added to inventory",
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

  const expirationHint =
    selectedCategory && !userEditedDate
      ? `≈ ${formatExpirationDate(expDays)} · suggested ${selectedCategory.name} shelf life`
      : `≈ ${formatExpirationDate(expDays)}`;

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

        <Field label="Storage">
          <SegmentedControl
            options={[...STORAGE_OPTIONS]}
            selected={storageLabel}
            onSelect={handleStorageSelect}
          />
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
});
