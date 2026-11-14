import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { RecipePressable } from "@/components/recipe-motion";
import { useTheme } from "@/hooks/useTheme";
import { useActiveCookStore } from "@/stores/activeCook";

type ActiveCookBannerProps = {
  /** Outer style, such as the margins where the banner sits on each screen. */
  style?: StyleProp<ViewStyle>;
};

/**
 * A "Cooking: <dish>" banner that opens `/cook`. Reads the active cook from
 * `useActiveCookStore` and renders nothing when there is none.
 */
export default function ActiveCookBanner({ style }: ActiveCookBannerProps) {
  const { colors, fonts } = useTheme();
  const router = useRouter();
  const title = useActiveCookStore((s) => s.activeCook?.recipe.title);
  if (!title) return null;

  return (
    <RecipePressable
      onPress={() => router.push("/cook")}
      accessibilityRole="button"
      accessibilityLabel={`Cooking: ${title}. Open recipe`}
      testID="active-cook-banner"
      style={[
        styles.banner,
        { backgroundColor: colors.accentSoft, borderColor: colors.border },
        style,
      ]}
    >
      <View style={[styles.icon, { backgroundColor: colors.accent }]}>
        <Ionicons name="flame" size={15} color={colors.accentInk} />
      </View>
      <Text
        numberOfLines={1}
        style={[styles.label, { color: colors.text, fontFamily: fonts.body }]}
      >
        <Text style={{ color: colors.accent, fontFamily: fonts.bodyStrong }}>
          Cooking:
        </Text>{" "}
        {title}
      </Text>
      <Feather name="chevron-right" size={18} color={colors.accent} />
    </RecipePressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { flex: 1, fontSize: 14 },
});
