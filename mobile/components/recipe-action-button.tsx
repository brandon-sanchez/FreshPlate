import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

type RecipeActionButtonProps = Pick<
  ComponentProps<typeof Pressable>,
  "onPress" | "disabled" | "testID" | "accessibilityHint" | "accessibilityLabel"
> & {
  label: string;
  variant?: "primary" | "secondary";
  style?: StyleProp<ViewStyle>;
};

// Native adaptation of @dillionverma's 21st Interactive Hover Button.
export default function RecipeActionButton({
  label,
  variant = "primary",
  style,
  disabled,
  accessibilityLabel,
  ...props
}: RecipeActionButtonProps) {
  const { colors, fonts } = useTheme();
  const { fontScale } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(320);
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const active = !disabled && (pressed || hovered || focused);
  const fillColor = variant === "primary" ? colors.accent : colors.accentSoft;
  const activeTextColor =
    variant === "primary" ? colors.accentInk : colors.accent;
  const restingTextColor = variant === "primary" ? colors.accent : colors.text;

  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(active ? 1 : 0);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: active ? 1 : 0,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [active, progress, reducedMotion]);

  return (
    <Pressable
      {...props}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        styles.button,
        {
          backgroundColor: colors.surface,
          borderColor:
            focused || variant === "primary" ? colors.accent : colors.border,
          opacity: disabled ? 0.45 : 1,
        },
        focused && {
          outlineColor: colors.accent,
          outlineWidth: 2,
          outlineOffset: 3,
        },
        style,
      ]}
    >
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      >
        <Animated.View
          style={[
            styles.fill,
            {
              backgroundColor: fillColor,
              transform: [
                {
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, Math.max(width, 56) / 4],
                  }),
                },
              ],
            },
          ]}
        />
      </View>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: "100%",
          opacity: progress.interpolate({
            inputRange: [0, 0.7, 1],
            outputRange: [1, 0, 0],
          }),
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 36],
              }),
            },
          ],
        }}
      >
        <Text
          key={fontScale}
          style={[
            styles.label,
            { color: restingTextColor, fontFamily: fonts.bodyStrong },
          ]}
        >
          {label}
        </Text>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.activeLabel,
          {
            opacity: progress,
            transform: [
              {
                translateX: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-28, 0],
                }),
              },
            ],
          },
        ]}
      >
        <Text
          key={fontScale}
          style={[
            styles.label,
            { color: activeTextColor, fontFamily: fonts.bodyStrong },
          ]}
        >
          {label}
        </Text>
        <Feather name="arrow-right" size={18} color={activeTextColor} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    paddingVertical: 15,
    paddingHorizontal: 44,
    borderRadius: 100,
    borderWidth: 1,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  fill: {
    position: "absolute",
    left: 22,
    top: "50%",
    marginTop: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: { fontSize: 14, lineHeight: 22, textAlign: "center", flexShrink: 1 },
  activeLabel: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 20,
  },
});
