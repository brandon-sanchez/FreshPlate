import React from "react";
import { ScrollView } from "react-native";
import { render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@react-navigation/bottom-tabs", () => ({ useBottomTabBarHeight: () => 0 }));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: object) => unknown) =>
    selector({ user: null, signOut: jest.fn() }),
  firstNameFromMetadata: () => null,
}));
jest.mock("@/hooks/useProfile", () => ({
  useProfile: () => ({ data: undefined }),
  firstNameFromProfile: () => null,
}));
jest.mock("@/components/kitchen-basics-editor", () => () => null);

import ProfileScreen from "@/app/(tabs)/profile";

describe("ProfileScreen", () => {
  it("keeps a focused field above the keyboard and lets taps through", () => {
    const screen = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 44, right: 0, bottom: 34, left: 0 },
        }}
      >
        <ProfileScreen />
      </SafeAreaProvider>,
    );

    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
  });
});
