import { useEffect, useRef, useState } from "react";
import {
  Animated,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useRecipeImage } from "@/hooks/useRecipeImage";
import { useReducedMotion } from "@/hooks/useReducedMotion";
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
 * Shows the generated photo of a recipe, filling its frame. A placeholder
 * stands in while the photo loads and when it is pending, unavailable,
 * failed or over budget.
 *
 * Reads {@link useRecipeImage}. Image bytes are cached on disk under the
 * result's `image_key`, so a re-signed URL for a cached photo costs no
 * download. Recipe text around the photo renders without waiting for it.
 */
export default function RecipePhoto({
  recipeId,
  title,
  variant,
  enabled = true,
  style,
}: RecipePhotoProps) {
  const iconSize = ICON_SIZES[variant];
  const { colors: themeColors } = useTheme();
  const reducedMotion = useReducedMotion();
  const image = useRecipeImage(recipeId, { enabled });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const result = image.data;
  const photo =
    result?.status === "ready" && result.url && result.url !== failedUrl
      ? { url: result.url, key: result.image_key }
      : null;
  const loading =
    !photo && enabled && (image.isLoading || result?.status === "pending");

  return (
    <View
      style={[styles.frame, { backgroundColor: themeColors.accentSoft }, style]}
    >
      {photo ? (
        <Image
          source={{ uri: photo.url, cacheKey: photo.key }}
          recyclingKey={photo.key}
          cachePolicy="memory-disk"
          contentFit="cover"
          transition={reducedMotion ? 0 : 200}
          onError={() => {
            // One re-sign per failure covers a URL that expired early. A
            // second failure on the fresh URL leaves the placeholder.
            if (failedUrl === null) void image.refetch();
            setFailedUrl(photo.url);
          }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`Photo of ${title}`}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <Placeholder
          loading={loading}
          animate={!reducedMotion}
          iconSize={iconSize}
          color={themeColors.accent}
        />
      )}
    </View>
  );
}

function Placeholder({
  loading,
  animate,
  iconSize,
  color,
}: {
  loading: boolean;
  animate: boolean;
  iconSize: number;
  color: string;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!loading || !animate) {
      opacity.setValue(1);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 800,
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [animate, loading, opacity]);

  return (
    <Animated.View
      testID={loading ? "recipe-photo-loading" : "recipe-photo-placeholder"}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.placeholder, { opacity }]}
    >
      <FontAwesome name="cutlery" size={iconSize} color={color} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden" },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
});
