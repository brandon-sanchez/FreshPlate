import React from "react";
import { fireEvent, render } from "@testing-library/react-native";

jest.mock("@expo/vector-icons/FontAwesome", () => {
  const MockIcon = () => null;
  return MockIcon;
});

import RecipePreferenceFlow from "@/components/recipe-preference-flow";

describe("RecipePreferenceFlow", () => {
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
});
