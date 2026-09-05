import { Tabs } from "expo-router";
import GlassTabBar from "@/components/glass-tab-bar";

export default function TabLayout() {
  return (
    <Tabs tabBar={(props) => <GlassTabBar {...props} />}
      screenOptions={{ headerShown: false, tabBarStyle: { position: "absolute", height: 84 } }}>
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="inventory" options={{ title: "Inventory" }} />
      <Tabs.Screen name="add-item" options={{ title: "Add item" }} />
      <Tabs.Screen name="recipes" options={{ title: "Recipes" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
