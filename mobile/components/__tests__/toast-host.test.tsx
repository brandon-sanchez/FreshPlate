import React from "react";
import { Keyboard, StyleSheet, type KeyboardEvent } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ToastHost, showUndoToast } from "@/components/toastConfig";
import Toast from "@/lib/toast";

jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  act(() => Toast.hide());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function toastStyle() {
  return StyleSheet.flatten(screen.getByTestId("toast").props.style);
}

it("sits at the bottom right, just above the tab bar", () => {
  render(<ToastHost bottomInset={118} />);
  act(() => Toast.show({ type: "success", text1: "Saved" }));
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(toastStyle()).toMatchObject({ right: 16, bottom: 130 });
});

it("rides above the keyboard while it is open", () => {
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  jest.spyOn(Keyboard, "addListener").mockImplementation((event, callback) => {
    listeners.set(event, callback);
    return { remove: jest.fn() } as never;
  });
  render(<ToastHost bottomInset={118} />);
  act(() => Toast.show({ type: "error", text1: "Couldn't save" }));
  act(() =>
    listeners.get("keyboardWillShow")?.({
      duration: 0,
      easing: "keyboard",
      endCoordinates: { screenX: 0, screenY: 500, width: 440, height: 336 },
    }),
  );
  expect(toastStyle()).toMatchObject({ bottom: 348 });
});

it("hides once its visibility time runs out", () => {
  render(<ToastHost bottomInset={0} />);
  act(() => Toast.show({ text1: "Deleted", visibilityTime: 1000 }));
  expect(screen.getByTestId("toast").props.pointerEvents).toBe("box-none");
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByTestId("toast").props.pointerEvents).toBe("none");
});

it("replaces the toast on screen with a newer one", () => {
  render(<ToastHost bottomInset={0} />);
  act(() => Toast.show({ text1: "First" }));
  act(() => Toast.show({ text1: "Second" }));
  expect(screen.queryByText("First")).toBeNull();
  expect(screen.getByText("Second")).toBeTruthy();
});

it("runs Undo once and hides the toast", () => {
  const onUndo = jest.fn();
  render(<ToastHost bottomInset={0} />);
  act(() => showUndoToast({ text1: "Milk tossed", onUndo }));
  fireEvent.press(screen.getByRole("button", { name: "Undo" }));
  fireEvent.press(screen.getByRole("button", { name: "Undo" }));
  expect(onUndo).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("toast").props.pointerEvents).toBe("none");
});
