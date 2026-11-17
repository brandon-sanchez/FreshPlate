import React from "react";
import { fireEvent, render } from "@testing-library/react-native";

const mockAdd = jest.fn();
const mockRemove = jest.fn();
const mockBasics = {
  current: { data: [] as { id: string; name: string }[] | undefined, isError: false },
};

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@/hooks/useKitchenBasics", () => ({
  MAX_KITCHEN_BASICS: 3,
  MAX_KITCHEN_BASIC_NAME_LENGTH: 40,
  useKitchenBasics: () => mockBasics.current,
  useAddKitchenBasic: () => ({ mutate: mockAdd, isPending: false }),
  useRemoveKitchenBasic: () => ({ mutate: mockRemove, isPending: false }),
}));

import KitchenBasicsEditor from "@/components/kitchen-basics-editor";

const SALT = { id: "b1", name: "Salt" };
const OIL = { id: "b2", name: "Olive oil" };

describe("KitchenBasicsEditor", () => {
  beforeEach(() => {
    mockAdd.mockReset();
    mockRemove.mockReset();
    mockBasics.current = { data: [SALT, OIL], isError: false };
  });

  it("lists each basic as a removable pill", () => {
    const screen = render(<KitchenBasicsEditor />);

    expect(screen.getByText("Salt")).toBeTruthy();
    expect(screen.getByText("Olive oil")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Remove Salt"));
    expect(mockRemove).toHaveBeenCalledWith(SALT);
  });

  it("adds a typed basic and clears the field", () => {
    mockAdd.mockImplementation((_name, options) => options.onSuccess());
    const screen = render(<KitchenBasicsEditor />);
    const field = screen.getByLabelText("New kitchen basic");

    fireEvent.changeText(field, "Butter");
    fireEvent.press(screen.getByLabelText("Add kitchen basic"));

    expect(mockAdd).toHaveBeenCalledWith("Butter", expect.anything());
    expect(field.props.value).toBe("");
  });

  it("ignores a blank name", () => {
    const screen = render(<KitchenBasicsEditor />);

    fireEvent.changeText(screen.getByLabelText("New kitchen basic"), "   ");
    fireEvent(screen.getByLabelText("New kitchen basic"), "submitEditing");

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("tells its parent when the add field gains and loses focus", () => {
    const onInputFocus = jest.fn();
    const onInputBlur = jest.fn();
    const screen = render(
      <KitchenBasicsEditor onInputFocus={onInputFocus} onInputBlur={onInputBlur} />,
    );
    const field = screen.getByLabelText("New kitchen basic");

    fireEvent(field, "focus");
    expect(onInputFocus).toHaveBeenCalledTimes(1);
    fireEvent(field, "blur");
    expect(onInputBlur).toHaveBeenCalledTimes(1);
  });

  it("stops offering to add once the list is full", () => {
    mockBasics.current = { data: [SALT, OIL, { id: "b3", name: "Water" }], isError: false };
    const screen = render(<KitchenBasicsEditor />);

    expect(screen.queryByLabelText("New kitchen basic")).toBeNull();
    expect(screen.getByText("Remove one to add another.")).toBeTruthy();
  });

  it("says when the list can't load", () => {
    mockBasics.current = { data: undefined, isError: true };
    const screen = render(<KitchenBasicsEditor />);

    expect(screen.getByText("Couldn't load your basics.")).toBeTruthy();
  });
});
