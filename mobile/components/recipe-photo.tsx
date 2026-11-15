import { useEffect, useRef, useState } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import Feather from "@expo/vector-icons/Feather";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { colors } from "@/constants/theme";
import { useRecipeImage } from "@/hooks/useRecipeImage";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

// Over a photo the badge needs a dark scrim in both themes, so it uses the
// dark theme's `bg` at 60% opacity rather than the active theme.
const BADGE_SCRIM = `${colors.dark.bg}99`;
const BADGE_INK = colors.dark.text;

type RecipePhotoVariant = "thumbnail" | "card" | "sheet" | "hero";

const VARIANTS: Record<
  RecipePhotoVariant,
  { iconSize: number; badgeOnPlaceholder: boolean; badgeLabel: boolean }
> = {
  thumbnail: { iconSize: 28, badgeOnPlaceholder: false, badgeLabel: false },
  card: { iconSize: 34, badgeOnPlaceholder: true, badgeLabel: true },
  sheet: { iconSize: 48, badgeOnPlaceholder: false, badgeLabel: true },
  hero: { iconSize: 68, badgeOnPlaceholder: false, badgeLabel: true },
};

type RecipePhotoProps = {
  /** The recipe snapshot's `recipe_id`; every view of it shares one photo. */
  recipeId: string;
  /** Recipe title, used in the photo's accessibility description. */
  title: string;
  /**
   * Where the photo appears, which sets its placeholder icon size and its
   * AI badge. `card` (feed card) shows the "Generated" badge over the photo
   * and the placeholder alike, since it also marks the generated recipe.
   * `sheet` (preview sheet) and `hero` (full detail) show it only on a
   * loaded photo. `thumbnail` (saved list) shows the sparkle alone on a
   * loaded photo.
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
  const { iconSize, badgeOnPlaceholder, badgeLabel } = VARIANTS[variant];
  const { colors: themeColors, fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  const image = useRecipeImage(recipeId, { enabled });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const result = image.data;
  const photo =
    result?.status === "ready" && result.url && result.url !== failedUrl
      ? { url: result.url, key: result.image_key }
      : null;
  const showPhoto = photo !== null;
  const loading =
    !showPhoto && enabled && (image.isLoading || result?.status === "pending");

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
          accessibilityLabel={`Generated photo of ${title}`}
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
      {(showPhoto || badgeOnPlaceholder) && (
        <View
          testID="recipe-photo-badge"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.badge,
            !badgeLabel && styles.iconBadge,
            showPhoto && { backgroundColor: BADGE_SCRIM },
          ]}
        >
          <Feather
            name="zap"
            size={13}
            color={showPhoto ? BADGE_INK : themeColors.accent}
          />
          {badgeLabel && (
            <Text
              style={{
                color: showPhoto ? BADGE_INK : themeColors.accent,
                fontFamily: fonts.bodyStrong,
                fontSize: 12,
              }}
            >
              Generated
            </Text>
          )}
        </View>
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
  badge: {
    position: "absolute",
    left: 12,
    bottom: 12,
    minHeight: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  iconBadge: {
    left: 8,
    bottom: 8,
    width: 26,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
});
