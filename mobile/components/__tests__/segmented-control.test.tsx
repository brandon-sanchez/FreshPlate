import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { setUpTests } from "react-native-reanimated";
import SegmentedControl from "@/components/SegmentedControl";
import { colors } from "@/constants/theme";

setUpTests();
jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => false }));

const STORAGE = ["Fridge", "Freezer", "Pantry"] as const;
const { accentInk, textMuted } = colors.light;

function rgba(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return `rgba(${r}, ${g}, ${b}, 1)`;
}

/** Gives the control its width, as the first native layout does. */
function layOut() {
  fireEvent(screen.getByText(STORAGE[0]), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 44 } },
  });
  act(() => jest.advanceTimersByTime(100));
}

it("calls onSelect with the tapped segment", () => {
  const onSelect = jest.fn();
  render(<SegmentedControl options={STORAGE} selected="Fridge" onSelect={onSelect} />);

  fireEvent.press(screen.getByRole("radio", { name: "Pantry" }));

  expect(onSelect).toHaveBeenCalledWith("Pantry");
});

it("checks only the selected segment", () => {
  render(<SegmentedControl options={STORAGE} selected="Freezer" onSelect={jest.fn()} />);

  expect(screen.getByRole("radio", { name: "Freezer" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "Fridge" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Pantry" })).not.toBeChecked();
});

it("inks the selected label in the accent ink once the control is laid out", () => {
  jest.useFakeTimers();
  render(<SegmentedControl options={STORAGE} selected="Freezer" onSelect={jest.fn()} />);
  expect(screen.getByText("Freezer")).toHaveAnimatedStyle({ color: rgba(textMuted) });

  layOut();

  expect(screen.getByText("Freezer")).toHaveAnimatedStyle({ color: rgba(accentInk) });
  expect(screen.getByText("Fridge")).toHaveAnimatedStyle({ color: rgba(textMuted) });
  jest.useRealTimers();
});

it("selects nothing when the value matches no segment", () => {
  jest.useFakeTimers();
  render(<SegmentedControl options={STORAGE} selected="Garage" onSelect={jest.fn()} />);
  layOut();

  for (const option of STORAGE) {
    expect(screen.getByRole("radio", { name: option })).not.toBeChecked();
    expect(screen.getByText(option)).toHaveAnimatedStyle({ color: rgba(textMuted) });
  }
  jest.useRealTimers();
});

it("announces tabs with a selected state when used as a view switcher", () => {
  render(
    <SegmentedControl options={STORAGE} selected="Pantry" onSelect={jest.fn()} role="tab" />,
  );

  expect(screen.getByRole("tab", { name: "Pantry" })).toBeSelected();
  expect(screen.getByRole("tab", { name: "Fridge" })).not.toBeSelected();
});
