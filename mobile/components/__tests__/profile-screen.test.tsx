import React from "react";
import { DeviceEventEmitter, ScrollView } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
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
jest.mock("@/components/kitchen-basics-editor", () => {
  const { TextInput } = jest.requireActual("react-native");
  return function MockKitchenBasicsEditor({
    onInputFocus,
    onInputBlur,
  }: {
    onInputFocus?: () => void;
    onInputBlur?: () => void;
  }) {
    return (
      <TextInput
        accessibilityLabel="New kitchen basic"
        onFocus={onInputFocus}
        onBlur={onInputBlur}
      />
    );
  };
});

import ProfileScreen from "@/app/(tabs)/profile";

function renderProfile() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 44, right: 0, bottom: 34, left: 0 },
      }}
    >
      <ProfileScreen />
    </SafeAreaProvider>,
  );
}

describe("ProfileScreen", () => {
  it("keeps a focused field above the keyboard and lets taps through", () => {
    const screen = renderProfile();

    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
  });

  it("scrolls the whole Kitchen basics card above the keyboard when adding a basic", () => {
    const screen = renderProfile();
    const scrollToKeyboard = scrollToKeyboardOf(screen);

    fireEvent(screen.getByLabelText("New kitchen basic"), "focus");
    showKeyboard();

    const card = screen.UNSAFE_getByProps({ testID: "kitchen-basics-card" });
    expect(scrollToKeyboard).toHaveBeenCalledWith(card.instance, 12, true);
  });

  it("leaves the scroll alone when the keyboard opens for no basics field", () => {
    const screen = renderProfile();
    const scrollToKeyboard = scrollToKeyboardOf(screen);
    const field = screen.getByLabelText("New kitchen basic");

    showKeyboard();
    fireEvent(field, "focus");
    fireEvent(field, "blur");
    showKeyboard();

    expect(scrollToKeyboard).not.toHaveBeenCalled();
  });
});

function scrollToKeyboardOf(screen: ReturnType<typeof renderProfile>) {
  const scroll = screen.UNSAFE_getByType(ScrollView).instance as ScrollView;
  const scrollToKeyboard = jest.mocked(
    scroll.scrollResponderScrollNativeHandleToKeyboard,
  );
  scrollToKeyboard.mockClear();
  return scrollToKeyboard;
}

function showKeyboard() {
  act(() => {
    DeviceEventEmitter.emit("keyboardDidShow", {
      duration: 250,
      easing: "keyboard",
      endCoordinates: { screenX: 0, screenY: 500, width: 390, height: 344 },
    });
  });
}
