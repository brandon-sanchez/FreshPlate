import React from "react";
import { Platform, Pressable, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/hooks/useTheme";

type IconName = React.ComponentProps<typeof FontAwesome>["name"];

function TabIcon({
  name,
  color,
  focused,
}: {
  name: IconName;
  color: string;
  focused: boolean;
}) {
  return <FontAwesome name={name} size={focused ? 22 : 20} color={color} />;
}

/**
 * Center "Add Item" tab — floats above the tab bar as an accent circular button.
 * Mockup: screens-a.jsx middle-tab treatment.
 */
function FloatingAddButton({
  accessibilityState,
  onPress,
}: {
  accessibilityState?: { selected?: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPress?: (e: any) => void;
}) {
  const { colors, card } = useTheme();
  const selected = !!accessibilityState?.selected;
  return (
    <Pressable
      onPress={onPress}
      style={{
        top: -16,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.accent,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: card.shadowColor,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: selected ? 0.18 : 0.14,
        shadowRadius: 10,
        elevation: 6,
      }}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Add item"
      accessibilityState={{ selected }}
    >
      <FontAwesome name="plus" size={22} color={colors.accentInk} />
    </Pressable>
  );
}

export default function TabLayout() {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 64 + insets.bottom,
          paddingTop: 8,
          paddingBottom: insets.bottom + 6,
        },
        tabBarLabelStyle: {
          fontFamily: fonts.body,
          fontSize: 10.5,
          letterSpacing: 0.1,
          marginTop: 2,
        },
        tabBarItemStyle: { paddingVertical: 2 },
        headerShown: false,
        // iOS tab presses provide a subtle haptic; Android relies on touch ripple.
        tabBarHideOnKeyboard: Platform.OS === "android",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="home" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="inventory"
        options={{
          title: "Inventory",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="list-ul" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="add-item"
        options={{
          title: "",
          tabBarIcon: () => null,
          tabBarButton: (props) => (
            <View
              style={{
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FloatingAddButton
                accessibilityState={
                  props.accessibilityState as { selected?: boolean }
                }
                onPress={props.onPress}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="recipes"
        options={{
          title: "Recipes",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="cutlery" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="user-o" color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
