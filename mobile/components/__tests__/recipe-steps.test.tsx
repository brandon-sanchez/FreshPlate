import React from "react";
import { render } from "@testing-library/react-native";
import RecipeSteps from "@/components/recipe-steps";

it("shows a string step's heading and body without a copied step number", () => {
  const screen = render(
    <RecipeSteps steps={["Step 1: Boil the pasta\nBoil it until al dente."]} />,
  );

  expect(screen.getByTestId("recipe-step-heading-0")).toHaveTextContent(
    "Boil the pasta",
  );
  expect(screen.getByTestId("recipe-step-body-0")).toHaveTextContent(
    "Boil it until al dente.",
  );
});

it("reads a structured step's reason and doneness cue into its body", () => {
  const screen = render(
    <RecipeSteps
      steps={[
        {
          instruction: "Sear the salmon\nLay the fillets in skin-side down.",
          doneness_cue: "Flip when the skin releases on its own.",
          minutes: 5,
          why: "moving the fish tears the skin",
          uses: ["salmon"],
        },
      ]}
    />,
  );

  expect(screen.getByTestId("recipe-step-heading-0")).toHaveTextContent(
    "Sear the salmon",
  );
  expect(screen.getByTestId("recipe-step-body-0")).toHaveTextContent(
    "Lay the fillets in skin-side down. Moving the fish tears the skin. " +
      "Flip when the skin releases on its own.",
  );
});
