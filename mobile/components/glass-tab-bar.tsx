import { useEffect, useRef, useState } from "react";
import { Animated, Keyboard, Platform, View } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "react-native";
import GlassTabBackground from "@/components/glass-tab-background";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

const ICONS = {
  index: "home",
  inventory: "archive",
  "add-item": "plus",
  recipes: "book-open",
  profile: "user",
} as const;
function iconForRoute(name: string) {
  switch (name) {
    case "index":
    case "inventory":
    case "add-item":
    case "recipes":
    case "profile":
      return ICONS[name];
    default:
      return "circle";
  }
}
export default function GlassTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(() =>
    Keyboard.isVisible(),
  );
  const position = useRef(new Animated.Value(state.index)).current;
  const slotWidth = width / state.routes.length;
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    if (reducedMotion) position.setValue(state.index);
    else
      Animated.spring(position, {
        toValue: state.index,
        stiffness: 320,
        damping: 30,
        mass: 0.7,
        useNativeDriver: true,
        isInteraction: false,
      }).start();
    return () => position.stopAnimation();
  }, [position, reducedMotion, state.index]);
  if (keyboardVisible) return null;
  return (
    <View
      testID="glass-tab-bar"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: Math.max(insets.bottom, 12),
        height: 72,
      }}
    >
      <GlassTabBackground />
      {width > 0 && state.routes[state.index]?.name !== "add-item" && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 7,
            bottom: 7,
            left: 4,
            width: slotWidth - 8,
            borderRadius: 30,
            backgroundColor: colors.accentSoft,
            transform: [{ translateX: Animated.multiply(position, slotWidth) }],
          }}
        />
      )}
      <View style={{ flexDirection: "row", flex: 1 }}>
        {state.routes.map((route, index) => {
          const selected = state.index === index;
          const isAdd = route.name === "add-item";
          const options = descriptors[route.key].options;
          const label = isAdd ? "Add item" : (options.title ?? route.name);
          return (
            <RecipePressable
              key={route.key}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              testID={"tab-" + route.name}
              onPress={() => {
                const event = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!selected && !event.defaultPrevented)
                  navigation.navigate(route.name, route.params);
              }}
              onLongPress={() =>
                navigation.emit({ type: "tabLongPress", target: route.key })
              }
              style={{
                flex: 1,
                minHeight: 60,
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              {isAdd ? (
                <View
                  style={{
                    width: 54,
                    height: 54,
                    borderRadius: 27,
                    backgroundColor: colors.accent,
                    alignItems: "center",
                    justifyContent: "center",
                    transform: [{ translateY: -12 }],
                    boxShadow: "0 4px 16px rgba(27,31,28,0.14)",
                  }}
                >
                  <Feather name="plus" size={25} color={colors.accentInk} />
                </View>
              ) : (
                <>
                  <Feather
                    name={iconForRoute(route.name)}
                    size={21}
                    color={selected ? colors.accent : colors.textMuted}
                  />
                  <Text
                    style={{
                      fontFamily: selected ? fonts.bodyStrong : fonts.body,
                      fontSize: 12,
                      color: selected ? colors.accent : colors.textMuted,
                    }}
                  >
                    {label}
                  </Text>
                </>
              )}
            </RecipePressable>
          );
        })}
      </View>
    </View>
  );
}
