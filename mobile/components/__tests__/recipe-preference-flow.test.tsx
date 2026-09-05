let mockReducedMotion = true;
jest.mock("@/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockReducedMotion,
}));
import React from "react";
import { Keyboard } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";

jest.mock("@expo/vector-icons/Feather", () => {
  const MockIcon = () => null;
  return MockIcon;
});

import RecipePreferenceFlow from "@/components/recipe-preference-flow";

describe("RecipePreferenceFlow", () => {
  afterEach(() => {
    mockReducedMotion = true;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("collects all six answers and returns them when generation starts", () => {
    const onComplete = jest.fn();
    const onCancel = jest.fn();
    const { getByTestId, getByText } = render(
      <RecipePreferenceFlow onComplete={onComplete} onCancel={onCancel} />,
    );

    expect(getByText("Which meal?")).toBeTruthy();
    expect(getByText("Step 1 of 6")).toBeTruthy();

    fireEvent.press(getByTestId("recipe-preference-option-meal-2"));
    fireEvent.press(getByTestId("recipe-preference-option-time-1"));
    fireEvent.press(getByTestId("recipe-preference-option-mood-0"));
    fireEvent.press(getByTestId("recipe-preference-option-cuisine-2"));
    fireEvent.press(getByTestId("recipe-preference-option-diet-3"));
    fireEvent.changeText(
      getByTestId("recipe-preference-occasion"),
      "date night",
    );
    fireEvent.press(getByTestId("recipe-preference-next"));

    expect(onComplete).toHaveBeenCalledWith({
      meal: "Dinner",
      time: "<30 min",
      mood: "Comfort",
      cuisine: "Italian",
      diet: "Vegetarian",
      occasion: "date night",
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("can stop at any step and generate with only the answers collected so far", () => {
    const onComplete = jest.fn();
    const { getByTestId } = render(
      <RecipePreferenceFlow onComplete={onComplete} onCancel={jest.fn()} />,
    );

    fireEvent.press(getByTestId("recipe-preference-option-meal-2"));
    fireEvent.press(getByTestId("recipe-preference-option-time-1"));
    fireEvent.press(getByTestId("recipe-preference-skip-flow"));

    expect(onComplete).toHaveBeenCalledWith({
      meal: "Dinner",
      time: "<30 min",
    });
  });

  it("skips an unanswered question without ending the flow", () => {
    const onComplete = jest.fn();
    const { getByTestId, getByText } = render(
      <RecipePreferenceFlow onComplete={onComplete} onCancel={jest.fn()} />,
    );

    fireEvent.press(getByTestId("recipe-preference-skip-question"));

    expect(getByText("How much time?")).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps a previous answer when going back, and removes it when skipped", () => {
    const onComplete = jest.fn();
    const { getByTestId } = render(
      <RecipePreferenceFlow onComplete={onComplete} onCancel={jest.fn()} />,
    );

    fireEvent.press(getByTestId("recipe-preference-option-meal-2"));
    fireEvent.press(getByTestId("recipe-preference-back"));
    expect(getByTestId("recipe-preference-option-meal-2")).toBeChecked();
    fireEvent.press(getByTestId("recipe-preference-skip-question"));
    fireEvent.press(getByTestId("recipe-preference-skip-flow"));

    expect(onComplete).toHaveBeenCalledWith({});
  });

  it("accepts trimmed context through the keyboard and submits only once", () => {
    const dismissKeyboard = jest.spyOn(Keyboard, "dismiss");
    const onComplete = jest.fn();
    const { getByTestId } = render(
      <RecipePreferenceFlow onComplete={onComplete} onCancel={jest.fn()} />,
    );
    for (let step = 0; step < 5; step += 1) {
      fireEvent.press(getByTestId("recipe-preference-skip-question"));
    }
    const input = getByTestId("recipe-preference-occasion");
    expect(getByTestId("recipe-preference-occasion-send")).toBeDisabled();
    fireEvent.changeText(input, "  dinner for two  ");
    fireEvent(input, "submitEditing");
    fireEvent.press(getByTestId("recipe-preference-next"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ occasion: "dinner for two" });
    expect(dismissKeyboard.mock.invocationCallOrder[0]).toBeLessThan(
      onComplete.mock.invocationCallOrder[0],
    );
  });

  it("ignores repeated selection while the next question is entering", () => {
    mockReducedMotion = false;
    jest.useFakeTimers();
    const { getByTestId, getByText } = render(
      <RecipePreferenceFlow onComplete={jest.fn()} onCancel={jest.fn()} />,
    );
    const dinner = getByTestId("recipe-preference-option-meal-2");
    fireEvent.press(dinner);
    fireEvent.press(dinner);
    expect(dinner).toBeDisabled();
    act(() => jest.advanceTimersByTime(1000));

    expect(getByText("How much time?")).toBeTruthy();
    expect(getByText("Step 2 of 6")).toBeTruthy();
    expect(getByTestId("recipe-preference-option-time-0")).not.toBeDisabled();
  });

  it("cancels during a question transition without completing the flow", () => {
    mockReducedMotion = false;
    jest.useFakeTimers();
    const onCancel = jest.fn();
    const onComplete = jest.fn();
    const { getByTestId, unmount } = render(
      <RecipePreferenceFlow onComplete={onComplete} onCancel={onCancel} />,
    );
    fireEvent.press(getByTestId("recipe-preference-option-meal-2"));
    fireEvent.press(getByTestId("recipe-preference-cancel"));
    unmount();
    act(() => jest.advanceTimersByTime(1000));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
