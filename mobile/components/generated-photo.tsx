import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import type { UseQueryResult } from "@tanstack/react-query";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { ImageResult } from "@/types/images";

type GeneratedPhotoProps = {
  /**
   * The image query from `useRecipeImage` or `useFoodImage`. While it is
   * disabled, the placeholder stays still.
   */
  image: UseQueryResult<ImageResult>;
  /**
   * Accessibility description of the photo, such as "Photo of Pasta". Leave
   * it out for a decorative photo beside text that already names its
   * subject; screen readers then skip the photo.
   */
  label?: string;
  /** Icon centered in the placeholder. */
  placeholder: ReactNode;
  /**
   * Prefix of the test IDs: `<prefix>-image` on the loaded image,
   * `<prefix>-loading` on the placeholder while the image loads or
   * generates, and `<prefix>-placeholder` otherwise.
   */
  testIDPrefix: string;
  /** Size, radius, background and position of the frame. */
  style?: StyleProp<ViewStyle>;
};

/**
 * Shows a generated image filling its frame, or a placeholder while it
 * loads and when it is pending, unavailable, failed or over budget. The
 * placeholder pulses while the image loads, unless Reduce Motion is on.
 *
 * Image bytes are cached on disk under the result's `image_key`, so a
 * re-signed URL for a cached image costs no download. When the image fails
 * to load, the URL is re-signed once to cover one that expired early; a
 * second failure leaves the placeholder.
 */
export default function GeneratedPhoto({
  image,
  label,
  placeholder,
  testIDPrefix,
  style,
}: GeneratedPhotoProps) {
  const reducedMotion = useReducedMotion();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const result = image.data;
  const photo =
    result?.status === "ready" && result.url && result.url !== failedUrl
      ? { url: result.url, key: result.image_key }
      : null;
  const loading =
    !photo &&
    image.isEnabled &&
    (image.isLoading || result?.status === "pending");

  return (
    <View style={[styles.frame, style]}>
      {photo ? (
        <Image
          source={{ uri: photo.url, cacheKey: photo.key }}
          recyclingKey={photo.key}
          cachePolicy="memory-disk"
          contentFit="cover"
          transition={reducedMotion ? 0 : 200}
          onError={() => {
            if (failedUrl === null) void image.refetch();
            setFailedUrl(photo.url);
          }}
          testID={`${testIDPrefix}-image`}
          {...(label === undefined
            ? {
                accessible: false,
                accessibilityElementsHidden: true,
                importantForAccessibility: "no-hide-descendants" as const,
              }
            : {
                accessible: true,
                accessibilityRole: "image" as const,
                accessibilityLabel: label,
              })}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <Placeholder
          loading={loading}
          animate={!reducedMotion}
          testID={`${testIDPrefix}-${loading ? "loading" : "placeholder"}`}
        >
          {placeholder}
        </Placeholder>
      )}
    </View>
  );
}

function Placeholder({
  loading,
  animate,
  testID,
  children,
}: {
  loading: boolean;
  animate: boolean;
  testID: string;
  children: ReactNode;
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
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.placeholder, { opacity }]}
    >
      {children}
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
