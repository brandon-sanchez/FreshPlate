import React from "react";
import { Text } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockReducedMotion = { current: true };
jest.mock("@/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockReducedMotion.current,
}));

import { RecipePressable } from "@/components/recipe-motion";

function renderButton(style?: { opacity: number }) {
  render(
    <RecipePressable accessibilityRole="button" accessibilityLabel="Done" onPress={() => {}} style={style}>
      <Text>Done</Text>
    </RecipePressable>,
  );
  return screen.getByRole("button", { name: "Done" });
}

beforeEach(() => {
  mockReducedMotion.current = true;
});

it("dims while held when Reduce Motion is on, and comes back on release", () => {
  const button = renderButton();
  expect(button).toHaveStyle({ opacity: 1 });

  fireEvent(button, "pressIn");
  expect(button).toHaveStyle({ opacity: 0.6 });

  fireEvent(button, "pressOut");
  expect(button).toHaveStyle({ opacity: 1 });
});

it("dims from the caller's own opacity", () => {
  const button = renderButton({ opacity: 0.5 });

  fireEvent(button, "pressIn");

  expect(button).toHaveStyle({ opacity: 0.3 });
});

it("leaves opacity alone when Reduce Motion is off", () => {
  mockReducedMotion.current = false;
  const button = renderButton();

  fireEvent(button, "pressIn");

  expect(button).not.toHaveStyle({ opacity: 0.6 });
});
