import React from "react";
import { Keyboard, Platform, type KeyboardEvent } from "react-native";
import { act, cleanup, render } from "@testing-library/react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import GlassTabBar from "@/components/glass-tab-bar";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@/components/glass-tab-background", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 34 }),
}));

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

it.each(["ios", "android"] as const)(
  "clears the %s navigation bar while typing and restores it when the keyboard closes",
  (platform) => {
    jest.replaceProperty(Platform, "OS", platform);
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const addListener = Keyboard.addListener.bind(Keyboard);
    const removals: jest.SpyInstance[] = [];
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
    jest
      .spyOn(Keyboard, "addListener")
      .mockImplementation((event, callback) => {
        listeners.set(event, callback);
        const subscription = addListener(event, callback);
        removals.push(jest.spyOn(subscription, "remove"));
        return subscription;
      });
    const props = {
      state: { index: 0, routes: [{ key: "recipes", name: "recipes" }] },
      descriptors: { recipes: { options: { title: "Recipes" } } },
      navigation: { emit: jest.fn(), navigate: jest.fn() },
    } as unknown as BottomTabBarProps;
    const view = render(<GlassTabBar {...props} />);
    expect(view.getByTestId("glass-tab-bar")).toBeTruthy();
    const event: KeyboardEvent = {
      duration: 0,
      easing: "keyboard",
      endCoordinates: { screenX: 0, screenY: 500, width: 390, height: 344 },
    };
    act(() =>
      listeners.get(
        platform === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      )?.(event),
    );
    expect(view.queryByTestId("glass-tab-bar")).toBeNull();
    act(() =>
      listeners.get(
        platform === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      )?.(event),
    );
    expect(view.getByTestId("glass-tab-bar")).toBeTruthy();
    view.unmount();
    for (const remove of removals) expect(remove).toHaveBeenCalledTimes(1);
  },
);
