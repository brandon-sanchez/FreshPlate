import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useTheme } from "@/hooks/useTheme";
import type { RecipeSuggestion } from "@/types/recipes";

type RecipeStatsProps = {
  /** The recipe whose cook time and servings the block shows. */
  recipe: Pick<RecipeSuggestion, "cook_time_minutes" | "servings">;
  /** Tightens the padding for the feed card, where height is fixed. */
  dense?: boolean;
  /**
   * Leaves the columns out of the accessibility tree, for a parent that
   * already reads the stats as part of its own label (see
   * {@link recipeStatsLabel}).
   */
  grouped?: boolean;
  /** Outer spacing from the parent layout. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Returns the spoken form of the stats, such as "25 minutes, serves 2", for
 * screen reader labels that cover the whole block.
 */
export function recipeStatsLabel(recipe: RecipeStatsProps["recipe"]) {
  return `${recipe.cook_time_minutes} minutes, serves ${recipe.servings}`;
}

/**
 * Shows a recipe's cook time and servings as two columns in a tinted block,
 * each with an icon, the value, and a label under it, Time first. Each
 * column reads as one phrase to screen readers, such as "Time, 25 minutes".
 */
export default function RecipeStats({
  recipe,
  dense = false,
  grouped = false,
  style,
  testID = "recipe-stats",
}: RecipeStatsProps) {
  const { colors } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.stats,
        dense && styles.dense,
        { backgroundColor: colors.surfaceAlt },
        style,
      ]}
    >
      <Stat
        icon="clock"
        label="Time"
        value={`${recipe.cook_time_minutes} min`}
        spokenLabel={
          grouped ? null : `Time, ${recipe.cook_time_minutes} minutes`
        }
      />
      <Stat
        icon="users"
        label="Serves"
        value={`${recipe.servings}`}
        spokenLabel={grouped ? null : `Serves ${recipe.servings}`}
      />
    </View>
  );
}

function Stat({
  icon,
  label,
  value,
  spokenLabel,
}: {
  icon: "clock" | "users";
  label: string;
  value: string;
  /** Screen reader label for the column, or `null` to leave it unannounced. */
  spokenLabel: string | null;
}) {
  const { colors, fonts } = useTheme();
  return (
    <View
      accessible={spokenLabel !== null}
      accessibilityLabel={spokenLabel ?? undefined}
      style={styles.stat}
    >
      <Feather name={icon} size={16} color={colors.textMuted} />
      <Text
        style={{
          color: colors.text,
          fontFamily: fonts.bodyStrong,
          fontVariant: ["tabular-nums"],
        }}
      >
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
  stats: { flexDirection: "row", padding: 16, borderRadius: 14 },
  dense: { paddingVertical: 8 },
  stat: { flex: 1, alignItems: "center", gap: 4 },
});
