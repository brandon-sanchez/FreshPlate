import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import Ionicons from "@expo/vector-icons/Ionicons";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Toast from "react-native-toast-message";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";
import RecipeSteps from "@/components/recipe-steps";

type RecipeViewProps = {
  recipe: RecipeSuggestion;
  isSaved: boolean;
  isSavePending: boolean;
  onToggleSave: (recipe: RecipeSuggestion, saved: boolean) => void;
  onClose: () => void;
  /** True when this recipe is the active cook, which pins "Done cooking". */
  cooking: boolean;
  cookPending: boolean;
  onCook: (recipe: RecipeSuggestion) => void;
  onDoneCooking: () => void;
};

type RecipeDetailProps = Omit<RecipeViewProps, "recipe"> & {
  recipe: RecipeSuggestion | null;
};

export default function RecipeDetail({ recipe, ...props }: RecipeDetailProps) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal
      visible={recipe !== null}
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={props.onClose}
    >
      {recipe && (
        <>
          <RecipeView recipe={recipe} {...props} />
          <Toast topOffset={insets.top + 60} />
        </>
      )}
    </Modal>
  );
}

/** Full-screen recipe with a pinned cook action, shared by detail and the active cook screen. */
export function RecipeView({
  recipe,
  isSaved,
  isSavePending,
  onToggleSave,
  onClose,
  cooking,
  cookPending,
  onCook,
  onDoneCooking,
}: RecipeViewProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const twoColumns = width >= 360 && fontScale < 1.6;
  const footerPadding = insets.bottom + 14;

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <View
        style={{
          height: insets.top + 60,
          backgroundColor: colors.accentSoft,
        }}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: footerPadding + 96 }}>
        <View
          style={[
            styles.hero,
            {
              height: 180,
              backgroundColor: colors.accentSoft,
            },
          ]}
        >
          <FontAwesome name="cutlery" size={68} color={colors.accent} />
        </View>
        <View style={styles.content}>
          <View style={styles.generated}>
            <Feather name="zap" size={14} color={colors.accent} />
            <Text
              style={{
                color: colors.textMuted,
                fontFamily: fonts.body,
                fontSize: 12,
              }}
            >
              Generated
            </Text>
          </View>
          <Text
            selectable
            style={[
              styles.title,
              { color: colors.text, fontFamily: fonts.display },
            ]}
          >
            {recipe.title}
          </Text>
          <View style={[styles.stats, { backgroundColor: colors.surfaceAlt }]}>
            <Stat
              icon="clock"
              label="Time"
              value={`${recipe.cook_time_minutes} min`}
            />
            <Stat icon="users" label="Serves" value={`${recipe.servings}`} />
            <Stat icon="zap" label="Match" value={`${recipe.match_percent}%`} />
          </View>
          <Text
            style={[
              styles.heading,
              { color: colors.textMuted, fontFamily: fonts.bodyStrong },
            ]}
          >
            Ingredients
          </Text>
          <View
            style={[
              styles.ingredientBox,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          >
            {(twoColumns
              ? [
                  recipe.ingredients.slice(
                    0,
                    Math.ceil(recipe.ingredients.length / 2),
                  ),
                  recipe.ingredients.slice(
                    Math.ceil(recipe.ingredients.length / 2),
                  ),
                ]
              : [recipe.ingredients]
            ).map((column, columnIndex) => (
              <View
                key={`ingredient-column-${columnIndex}`}
                testID={`recipe-detail-ingredient-column-${columnIndex}`}
                style={styles.ingredientColumn}
              >
                {column.map((item, index) => {
                  const itemIndex = twoColumns
                    ? columnIndex * Math.ceil(recipe.ingredients.length / 2) +
                      index
                    : index;
                  return (
                    <View
                      key={`${item.name}-${itemIndex}`}
                      testID={`recipe-detail-ingredient-${itemIndex}`}
                      style={styles.ingredient}
                    >
                      <Text
                        style={{
                          color: colors.accent,
                          fontSize: 18,
                          lineHeight: 20,
                        }}
                      >
                        •
                      </Text>
                      <Text
                        selectable
                        style={{
                          color: colors.text,
                          fontFamily: fonts.body,
                          fontSize: 14,
                          lineHeight: 20,
                          flex: 1,
                        }}
                      >
                        <Text style={{ fontFamily: fonts.bodyStrong }}>
                          {Number(item.use_amount.toFixed(2))} {item.unit}
                        </Text>{" "}
                        {item.name}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
          <Text
            style={[
              styles.heading,
              { color: colors.textMuted, fontFamily: fonts.bodyStrong },
            ]}
          >
            Steps
          </Text>
          <RecipeSteps steps={recipe.steps} />
        </View>
      </ScrollView>
      <RecipePressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close recipe details"
        style={[styles.heroButton, { top: insets.top + 8, left: 16 }]}
      >
        <Feather name="chevron-left" size={24} color="#1B1F1C" />
      </RecipePressable>
      <RecipePressable
        disabled={isSavePending}
        onPress={() => onToggleSave(recipe, isSaved)}
        accessibilityRole="button"
        accessibilityLabel={
          isSaved ? "Remove recipe from saved recipes" : "Save recipe"
        }
        accessibilityState={{ selected: isSaved, disabled: isSavePending }}
        style={[
          styles.heroButton,
          {
            top: insets.top + 8,
            right: 16,
            backgroundColor: isSaved ? colors.accent : "rgba(255,255,255,0.92)",
            opacity: isSavePending ? 0.6 : 1,
          },
        ]}
      >
        {isSaved ? (
          <FontAwesome name="bookmark" size={19} color={colors.accentInk} />
        ) : (
          <Feather name="bookmark" size={19} color="#1B1F1C" />
        )}
      </RecipePressable>
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
          disabled={cookPending}
          onPress={() => (cooking ? onDoneCooking() : onCook(recipe))}
          accessibilityRole="button"
          accessibilityState={{ disabled: cookPending }}
          testID="recipe-cook-action"
          style={[
            styles.cookButton,
            {
              backgroundColor: colors.accent,
              opacity: cookPending ? 0.6 : 1,
            },
          ]}
        >
          {cooking ? (
            <Feather name="check" size={18} color={colors.accentInk} />
          ) : (
            <Ionicons name="flame" size={18} color={colors.accentInk} />
          )}
          <Text
            style={{
              color: colors.accentInk,
              fontFamily: fonts.bodyStrong,
              fontSize: 16,
            }}
          >
            {cooking ? "Done cooking" : "Cook this"}
          </Text>
        </RecipePressable>
      </View>
    </View>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: "clock" | "users" | "zap";
  label: string;
  value: string;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View style={styles.stat}>
      <Feather name={icon} size={16} color={colors.textMuted} />
      <Text style={{ color: colors.text, fontFamily: fonts.bodyStrong }}>
        {value}
      </Text>
      <Text
        style={{
          color: colors.textMuted,
          fontFamily: fonts.body,
          fontSize: 12,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  hero: { alignItems: "center", justifyContent: "center" },
  heroButton: {
    position: "absolute",
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  content: { padding: 20 },
  generated: { flexDirection: "row", gap: 6, alignItems: "center" },
  title: { fontSize: 26, lineHeight: 32, marginTop: 8 },
  stats: { flexDirection: "row", padding: 16, marginTop: 16, borderRadius: 14 },
  stat: { flex: 1, alignItems: "center", gap: 4 },
  heading: {
    fontSize: 13,
    textTransform: "uppercase",
    marginTop: 24,
    marginBottom: 10,
  },
  ingredientBox: {
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  ingredient: {
    padding: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  ingredientColumn: { flex: 1, minWidth: 0 },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 16,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cookButton: {
    minHeight: 54,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
});
