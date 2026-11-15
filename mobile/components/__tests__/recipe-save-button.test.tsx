import { fireEvent, render } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import RecipeSaveButton from "@/components/recipe-save-button";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@expo/vector-icons/FontAwesome", () => () => null);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
}));
const mockReducedMotion = jest.fn(() => false);
jest.mock("@/hooks/useReducedMotion", () => ({
  useReducedMotion: () => mockReducedMotion(),
}));

const props = {
  title: "Spinach Pasta",
  disabled: false,
  variant: "pill" as const,
  testID: "save",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReducedMotion.mockReturnValue(false);
});

it("plays a light haptic and calls onPress", () => {
  const onPress = jest.fn();
  const screen = render(
    <RecipeSaveButton {...props} saved={false} onPress={onPress} />,
  );
  fireEvent.press(screen.getByLabelText("Save Spinach Pasta to household cookbook"));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(Haptics.impactAsync).toHaveBeenCalledWith("light");
});

it("reports the saved state to screen readers and flips its label", () => {
  const screen = render(
    <RecipeSaveButton {...props} saved={false} onPress={jest.fn()} />,
  );
  expect(screen.getByText("Save")).toBeTruthy();
  screen.rerender(<RecipeSaveButton {...props} saved onPress={jest.fn()} />);
  expect(
    screen.getByLabelText("Remove Spinach Pasta from saved recipes").props
      .accessibilityState,
  ).toEqual({ selected: true, disabled: false });
  expect(screen.getByText("Saved")).toBeTruthy();
});

it("ignores presses while a save is in flight", () => {
  const onPress = jest.fn();
  const screen = render(
    <RecipeSaveButton {...props} saved={false} disabled onPress={onPress} />,
  );
  fireEvent.press(screen.getByTestId("save"));
  expect(onPress).not.toHaveBeenCalled();
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
});

it("renders the round variant without a text label", () => {
  const screen = render(
    <RecipeSaveButton {...props} variant="round" saved onPress={jest.fn()} />,
  );
  expect(screen.queryByText("Saved")).toBeNull();
  expect(
    screen.getByLabelText("Remove Spinach Pasta from saved recipes"),
  ).toBeTruthy();
});

it("shows a save made elsewhere without the press animation", () => {
  const screen = render(
    <RecipeSaveButton {...props} saved={false} onPress={jest.fn()} />,
  );
  screen.rerender(<RecipeSaveButton {...props} saved onPress={jest.fn()} />);
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
});
