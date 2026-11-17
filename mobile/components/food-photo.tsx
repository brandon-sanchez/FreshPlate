import type { ComponentProps } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import GeneratedPhoto from "@/components/generated-photo";
import { useFoodImage } from "@/hooks/useFoodImage";
import { useTheme } from "@/hooks/useTheme";

type IconName = ComponentProps<typeof FontAwesome>["name"];

// Placeholder icon and corner radius as fractions of the tile's side, so a
// 48 pt inventory tile gets a 22 pt icon and 12 pt corners.
const ICON_RATIO = 0.46;
const RADIUS_RATIO = 0.25;

type FoodPhotoProps = {
  /**
   * The food the thumbnail shows. Foods with the same profile or name share
   * one image. `null`, for water or another ingredient that uses no food,
   * always shows the placeholder.
   */
  foodId: string | null;
  /** Side of the square tile, in points. */
  size: number;
  /**
   * FontAwesome icon for the placeholder, usually the food's category icon.
   * `null` or missing shows a leaf.
   */
  icon?: string | null;
  /**
   * Whether to request the thumbnail. The first request for an ingredient
   * may start a paid generation, so pass `false` for a tile that is not on
   * screen yet.
   */
  enabled: boolean;
  /** Extra tile styles, such as margins. */
  style?: StyleProp<ViewStyle>;
};

/**
 * Shows the generated thumbnail of a food as a rounded square tile, with
 * its category icon as the placeholder while it loads and whenever it is
 * not available.
 *
 * The thumbnail is decorative: every caller shows the food's name beside
 * it, so screen readers skip it. Reads {@link useFoodImage}. Text beside the
 * tile renders without waiting for it.
 */
export default function FoodPhoto({
  foodId,
  size,
  icon,
  enabled,
  style,
}: FoodPhotoProps) {
  const { colors } = useTheme();
  const image = useFoodImage(foodId, { enabled });

  return (
    <GeneratedPhoto
      image={image}
      placeholder={
        <FontAwesome
          name={(icon ?? "leaf") as IconName}
          size={Math.round(size * ICON_RATIO)}
          color={colors.textMuted}
        />
      }
      testIDPrefix="food-photo"
      style={[
        {
          width: size,
          height: size,
          borderRadius: size * RADIUS_RATIO,
          backgroundColor: colors.surfaceAlt,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.photoOutline,
        },
        style,
      ]}
    />
  );
}
