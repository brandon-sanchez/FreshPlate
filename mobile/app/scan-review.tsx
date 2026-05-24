import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import ItemForm, { ItemFormDefaults } from "@/components/ItemForm";
import LoadingState from "@/components/LoadingState";
import { useTheme } from "@/hooks/useTheme";
import { useAddItem } from "@/hooks/useAddItem";
import { useBarcodeLookup, isValidBarcode } from "@/hooks/useBarcodeLookup";
import { useFoodCategories } from "@/hooks/useFoodCategories";
import {
  defaultStorageForCategory,
  matchCategory,
  parseQuantity,
} from "@/lib/categoryMatch";
import { FoodCategory } from "@/hooks/useFoodCategories";
import { BarcodeProduct } from "@/types/barcode";

function buildDefaults(
  product: BarcodeProduct,
  matchedCategory: FoodCategory | null,
): ItemFormDefaults {
  const parsedQty = parseQuantity(product.quantity);
  return {
    name: (product.name ?? product.brand ?? "").trim(),
    categoryId: matchedCategory?.id ?? null,
    storage: defaultStorageForCategory(matchedCategory),
    quantity: parsedQty ? String(parsedQty.quantity) : "1",
    unit: parsedQty ? parsedQty.unit : "item",
    /* expDays omitted so ItemForm seeds the USDA default after the category
     * resolves. */
  };
}

function buildSubtitle(
  product: BarcodeProduct,
  matchedCategory: FoodCategory | null,
): string {
  const parts: string[] = [];
  if (product.quantity) parts.push(product.quantity);
  if (matchedCategory) parts.push(matchedCategory.name);
  const storage = defaultStorageForCategory(matchedCategory);
  parts.push(storage.charAt(0).toUpperCase() + storage.slice(1));
  return parts.join(" · ");
}

export default function ScanReviewScreen() {
  const { colors, fonts, card } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { barcode } = useLocalSearchParams<{ barcode?: string }>();

  const lookup = useBarcodeLookup(barcode);
  const { data: categories } = useFoodCategories();
  const addItem = useAddItem();

  useEffect(() => {
    if (lookup.isError) {
      Toast.show({
        type: "error",
        text1: "Lookup failed",
        text2: "We couldn't reach the barcode service. Pull to retry.",
      });
    }
  }, [lookup.isError]);

  const product = lookup.data?.data ?? null;

  const matchedCategory = useMemo(
    () => (product ? matchCategory(product.categories, categories) : null),
    [product, categories],
  );

  const defaults = useMemo<ItemFormDefaults | null>(
    () => (product ? buildDefaults(product, matchedCategory) : null),
    [product, matchedCategory],
  );

  const goToManualWithBarcode = () => {
    router.replace({
      pathname: "/(tabs)/add-item",
      params: barcode ? { barcode } : undefined,
    });
  };

  const invalidParam = !isValidBarcode(barcode);

  return (
    <>
      <Stack.Screen options={{ title: "Review item" }} />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {invalidParam ? (
          <ScrollView
            contentContainerStyle={{
              flexGrow: 1,
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 24,
            }}
          >
            <EmptyState
              icon={
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: colors.accentSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FontAwesome name="exclamation" size={22} color={colors.accent} />
                </View>
              }
              title="No barcode"
              message="We didn't get a barcode to look up. Try scanning again."
              ctaLabel="Back to scanner"
              onCtaPress={() => router.back()}
            />
          </ScrollView>
        ) : lookup.isLoading || lookup.isFetching && !lookup.data ? (
          <View
            style={{
              flex: 1,
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 24,
            }}
          >
            <LoadingState label={`Looking up ${barcode}…`} />
          </View>
        ) : lookup.isError ? (
          <View
            style={{
              flex: 1,
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 24,
            }}
          >
            <ErrorState
              title="Couldn't reach lookup service"
              message="The barcode service is offline or unreachable. Check your connection and try again, or add the item manually."
              onRetry={() => lookup.refetch()}
            />
          </View>
        ) : product === null ? (
          <ScrollView
            contentContainerStyle={{
              flexGrow: 1,
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 24,
            }}
          >
            <EmptyState
              icon={
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: colors.accentSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <FontAwesome name="question" size={22} color={colors.accent} />
                </View>
              }
              title="Product not found"
              message="Open Food Facts doesn't have this barcode yet. You can still add it manually."
              ctaLabel="Add manually"
              onCtaPress={goToManualWithBarcode}
            />
          </ScrollView>
        ) : (
          <ItemForm
            categories={categories}
            /* `resetKey` bumps when the matched category id changes so the
             * form re-seeds once `useFoodCategories` resolves after the lookup. */
            resetKey={`${product.barcode}:${matchedCategory?.id ?? "none"}`}
            defaults={defaults ?? undefined}
            submitLabel="Add to inventory"
            submittingLabel="Adding…"
            isSubmitting={addItem.isPending}
            contentContainerStyle={{
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 24,
            }}
            header={
              <ReviewHeader
                product={product}
                subtitle={buildSubtitle(product, matchedCategory)}
                colors={colors}
                fonts={fonts}
                card={card}
              />
            }
            onSubmit={(input) => {
              const addedName = input.name;
              addItem.mutate(input, {
                onSuccess: ({ id, merged }) => {
                  Toast.show({
                    type: "success",
                    text1: merged
                      ? `Updated ${addedName}`
                      : `Added ${addedName}`,
                    text2: merged
                      ? "Added to your existing item."
                      : "Tap to view in your inventory.",
                  });
                  router.replace({
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
              });
            }}
          />
        )}
      </View>
    </>
  );
}

type ReviewHeaderProps = {
  product: BarcodeProduct;
  subtitle: string;
  colors: ReturnType<typeof useTheme>["colors"];
  fonts: ReturnType<typeof useTheme>["fonts"];
  card: ReturnType<typeof useTheme>["card"];
};

function ReviewHeader({ product, subtitle, colors, fonts, card }: ReviewHeaderProps) {
  const displayName =
    product.name?.trim() || product.brand?.trim() || "Unknown product";

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        padding: 16,
        marginBottom: 16,
        shadowColor: card.shadowColor,
        shadowOffset: card.shadowOffset,
        shadowOpacity: card.shadowOpacity,
        shadowRadius: card.shadowRadius,
        elevation: card.elevation,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 4,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.bodyStrong,
          fontSize: 11,
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.7,
          marginBottom: 4,
        }}
      >
        Open Food Facts match
      </Text>
      <Text
        style={{
          fontFamily: fonts.display,
          fontSize: 20,
          color: colors.text,
          letterSpacing: -0.4,
          lineHeight: 26,
        }}
      >
        {displayName}
      </Text>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 13,
          color: colors.textMuted,
          marginTop: 2,
        }}
      >
        {subtitle}
      </Text>
      <Text
        style={{
          fontFamily: fonts.body,
          fontSize: 11.5,
          color: colors.textSubtle,
          marginTop: 8,
        }}
      >
        Barcode {product.barcode} · review the details below before saving.
      </Text>
    </View>
  );
}
