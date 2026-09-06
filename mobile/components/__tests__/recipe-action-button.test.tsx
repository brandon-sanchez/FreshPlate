import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import RecipeActionButton from "@/components/recipe-action-button";

jest.mock("@/hooks/useReducedMotion", () => ({ useReducedMotion: () => true }));
jest.mock("@expo/vector-icons/Feather", () => () => null);

describe("RecipeActionButton", () => {
  it("keeps one accessible action while focused and activates the chosen variant", () => {
    const generate = jest.fn();
    const edit = jest.fn();
    const { getByRole, getAllByRole } = render(
      <>
        <RecipeActionButton label="Generate recipes" onPress={generate} />
        <RecipeActionButton
          label="Edit answers"
          variant="secondary"
          onPress={edit}
        />
      </>,
    );

    const primary = getByRole("button", { name: "Generate recipes" });
    fireEvent(primary, "focus");
    expect(getAllByRole("button")).toHaveLength(2);
    fireEvent.press(primary);
    fireEvent.press(getByRole("button", { name: "Edit answers" }));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("exposes a disabled action without accepting a press", () => {
    const onPress = jest.fn();
    const { getByRole } = render(
      <RecipeActionButton
        label="Generate recipes"
        disabled
        onPress={onPress}
      />,
    );
    const button = getByRole("button", { name: "Generate recipes" });
    expect(button).toBeDisabled();
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
