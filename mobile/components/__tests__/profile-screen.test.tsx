import React from "react";
import { Alert, DeviceEventEmitter, ScrollView } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@react-navigation/bottom-tabs", () => ({ useBottomTabBarHeight: () => 0 }));
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
const mockAuth = {
  user: null as { email?: string } | null,
  signOut: jest.fn(),
};
jest.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (s: object) => unknown) => selector(mockAuth),
  firstNameFromMetadata: () => null,
}));
const mockProfile = { data: undefined as { display_name: string } | undefined };
jest.mock("@/hooks/useProfile", () => ({
  useProfile: () => mockProfile,
  firstNameFromProfile: (name: string | null | undefined) =>
    name?.trim().split(/\s+/)[0] ?? null,
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
  beforeEach(() => {
    mockAuth.user = null;
    mockAuth.signOut.mockReset();
    mockProfile.data = undefined;
  });

  it("shows the person's name and only a masked email", () => {
    mockAuth.user = { email: "brandonsanchez5051@gmail.com" };
    mockProfile.data = { display_name: "Brandon Sanchez" };

    const screen = renderProfile();

    expect(screen.getByText("Brandon Sanchez")).toBeTruthy();
    expect(screen.getByText("b•••@gmail.com")).toBeTruthy();
    expect(screen.queryByText(/brandonsanchez5051/)).toBeNull();
  });

  it("shows no development copy or sections that aren't built", () => {
    const screen = renderProfile();

    for (const text of [
      /phase/i,
      /placeholder/i,
      /coming/i,
      /for now/i,
      /taste profile/i,
      /dietary/i,
      /household/i,
      /expiration alerts/i,
    ]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.getByText("Kitchen basics")).toBeTruthy();
  });

  it("signs out after the person confirms", () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const screen = renderProfile();

    fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    const buttons = alert.mock.calls[0][2] ?? [];
    void buttons.find((button) => button.text === "Sign out")?.onPress?.();

    expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

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
