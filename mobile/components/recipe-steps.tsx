import { Text, View, useWindowDimensions } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { readRecipeSteps } from "@/lib/recipe-format";
import type { RecipeStep, RecipeSuggestion } from "@/types/recipes";

function asSentence(text: string | null | undefined): string {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return "";
  const capitalized = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : capitalized + ".";
}

function stepHeadingAndBody(step: RecipeStep): {
  heading: string | null;
  body: string;
} {
  const [firstLine, ...rest] = step.instruction.split(/\r?\n/);
  const instructionBody = rest.join("\n").trim();
  const heading = instructionBody ? firstLine.trim() || null : null;
  const body = [
    instructionBody || step.instruction.trim(),
    asSentence(step.why),
    asSentence(step.doneness_cue),
  ]
    .filter(Boolean)
    .join(" ");
  return { heading, body };
}

/** Numbered recipe method, read from either saved step shape. */
export default function RecipeSteps({
  steps,
}: {
  /** The recipe's steps, as plain strings or structured steps. */
  steps: RecipeSuggestion["steps"];
}) {
  const { colors, fonts } = useTheme();
  const { fontScale } = useWindowDimensions();
  const markerSize = Math.max(24, Math.ceil(24 * fontScale));

  return (
    <View testID="recipe-steps" style={{ gap: 12 }}>
      {readRecipeSteps(steps).map((step, index) => {
        const parsed = stepHeadingAndBody(step);
        return (
          <View
            key={`${index}-${step.instruction}`}
            testID={`recipe-step-${index}`}
            style={{
              flexDirection: "row",
              gap: 12,
              paddingVertical: 8,
            }}
          >
            <View
              style={{
                minWidth: markerSize,
                height: markerSize,
                borderRadius: markerSize / 2,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.accentSoft,
                flexShrink: 0,
              }}
            >
              <Text
                style={{
                  color: colors.accent,
                  fontFamily: fonts.bodyStrong,
                  fontSize: 14,
                }}
              >
                {index + 1}
              </Text>
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              {parsed.heading && (
                <Text
                  selectable
                  testID={`recipe-step-heading-${index}`}
                  style={{
                    color: colors.text,
                    fontFamily: fonts.bodyStrong,
                    fontSize: 15,
                    lineHeight: 20,
                  }}
                >
                  {parsed.heading}
                </Text>
              )}
              <Text
                selectable
                testID={`recipe-step-body-${index}`}
                style={{
                  color: colors.text,
                  fontFamily: fonts.body,
                  fontSize: 14,
                  lineHeight: 22,
                }}
              >
                {parsed.body}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
