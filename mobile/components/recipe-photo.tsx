import type { StyleProp, ViewStyle } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import GeneratedPhoto from "@/components/generated-photo";
import { useRecipeImage } from "@/hooks/useRecipeImage";
import { useTheme } from "@/hooks/useTheme";

type RecipePhotoVariant = "thumbnail" | "card" | "sheet" | "hero";

// Placeholder icon size per variant, in points.
const ICON_SIZES: Record<RecipePhotoVariant, number> = {
  thumbnail: 28,
  card: 34,
  sheet: 48,
  hero: 68,
};

type RecipePhotoProps = {
  /** The recipe snapshot's `recipe_id`; every view of it shares one photo. */
  recipeId: string;
  /** Recipe title, used in the photo's accessibility description. */
  title: string;
  /**
   * Where the photo appears, which sets its placeholder icon size:
   * `thumbnail` (saved list), `card` (feed card), `sheet` (preview sheet)
   * or `hero` (full detail).
   */
  variant: RecipePhotoVariant;
  /**
   * `false` defers the request, which may start a paid generation, until
   * the view is about to be seen. Defaults to `true`.
   */
  enabled?: boolean;
  /** Size, radius and position of the photo frame. */
  style?: StyleProp<ViewStyle>;
};

/**
 * Shows the generated photo of a recipe, filling its frame, with a cutlery
 * placeholder while it loads and whenever it is not available.
 *
 * Reads {@link useRecipeImage}. Recipe text around the photo renders
 * without waiting for it.
 */
export default function RecipePhoto({
  recipeId,
  title,
  variant,
  enabled = true,
  style,
}: RecipePhotoProps) {
  const { colors } = useTheme();
  const image = useRecipeImage(recipeId, { enabled });

  return (
    <GeneratedPhoto
      image={image}
      label={`Photo of ${title}`}
      placeholder={
        <FontAwesome
          name="cutlery"
          size={ICON_SIZES[variant]}
          color={colors.accent}
        />
      }
      testIDPrefix="recipe-photo"
      style={[{ backgroundColor: colors.accentSoft }, style]}
    />
  );
}
