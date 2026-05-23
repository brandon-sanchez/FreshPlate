import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useEffect, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FoodCategory } from "@/hooks/useFoodCategories";

export type InventoryFilters = {
  locations: string[];
  categories: string[];
  expiringWeek: boolean;
  leftoversOnly: boolean;
};

export const EMPTY_FILTERS: InventoryFilters = {
  locations: [],
  categories: [],
  expiringWeek: false,
  leftoversOnly: false,
};

export function countActiveFilters(f: InventoryFilters): number {
  return (
    f.locations.length +
    f.categories.length +
    (f.expiringWeek ? 1 : 0) +
    (f.leftoversOnly ? 1 : 0)
  );
}

const LOCATIONS = ["fridge", "freezer", "pantry"] as const;

type FilterSheetProps = {
  visible: boolean;
  filters: InventoryFilters;
  categories: FoodCategory[];
  onApply: (next: InventoryFilters) => void;
  onClose: () => void;
};

function FilterSheet({
  visible,
  filters,
  categories,
  onApply,
  onClose,
}: FilterSheetProps) {
  const { colors, fonts } = useTheme();
  const [local, setLocal] = useState<InventoryFilters>(filters);

  useEffect(() => {
    if (visible) setLocal(filters);
  }, [visible, filters]);

  const toggleLocation = (loc: string) =>
    setLocal((l) => ({
      ...l,
      locations: l.locations.includes(loc)
        ? l.locations.filter((x) => x !== loc)
        : [...l.locations, loc],
    }));

  const toggleCategory = (id: string) =>
    setLocal((l) => ({
      ...l,
      categories: l.categories.includes(id)
        ? l.categories.filter((x) => x !== id)
        : [...l.categories, id],
    }));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.4)",
          justifyContent: "flex-end",
        }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: 24,
            maxHeight: "85%",
          }}
        >
          <View
            style={{
              width: 40,
              height: 4,
              backgroundColor: colors.border,
              borderRadius: 2,
              alignSelf: "center",
              marginBottom: 14,
            }}
          />

          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 18,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.display,
                fontSize: 22,
                letterSpacing: -0.4,
                color: colors.text,
              }}
            >
              Filters
            </Text>
            <Pressable onPress={() => setLocal(EMPTY_FILTERS)}>
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  fontSize: 13,
                  color: colors.textMuted,
                }}
              >
                Clear all
              </Text>
            </Pressable>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            <FilterGroup label="Location">
              {LOCATIONS.map((loc) => (
                <Chip
                  key={loc}
                  label={capitalize(loc)}
                  selected={local.locations.includes(loc)}
                  onPress={() => toggleLocation(loc)}
                />
              ))}
            </FilterGroup>

            <FilterGroup label="Category">
              {categories.map((c) => (
                <Chip
                  key={c.id}
                  label={c.name}
                  selected={local.categories.includes(c.id)}
                  onPress={() => toggleCategory(c.id)}
                />
              ))}
            </FilterGroup>

            <FilterGroup label="Quick filters">
              <Chip
                label="Expiring this week"
                selected={local.expiringWeek}
                onPress={() =>
                  setLocal((l) => ({ ...l, expiringWeek: !l.expiringWeek }))
                }
              />
              <Chip
                label="Leftovers only"
                selected={local.leftoversOnly}
                onPress={() =>
                  setLocal((l) => ({ ...l, leftoversOnly: !l.leftoversOnly }))
                }
              />
            </FilterGroup>
          </ScrollView>

          <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
            <Pressable
              onPress={onClose}
              style={{
                flex: 1,
                height: 48,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  fontSize: 14,
                  color: colors.text,
                }}
              >
                Cancel
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                onApply(local);
                onClose();
              }}
              style={{
                flex: 1,
                height: 48,
                borderRadius: 12,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.bodyStrong,
                  fontSize: 14,
                  color: colors.accentInk,
                }}
              >
                Apply
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View style={{ marginBottom: 18 }}>
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 11,
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          marginBottom: 10,
        }}
      >
        {label}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {children}
      </View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors, fonts } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 100,
        backgroundColor: selected ? colors.accent : colors.surfaceAlt,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 13,
          color: selected ? colors.accentInk : colors.text,
          letterSpacing: -0.1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default FilterSheet;
