import { Text, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";

function splitStep(step: string): { heading: string | null; body: string } {
  const [firstLine, ...rest] = step.split(/\r?\n/);
  const body = rest.join("\n").trim();
  return body
    ? { heading: firstLine.trim() || null, body }
    : { heading: null, body: step.trim() };
}

export default function RecipeSteps({ steps }: { steps: string[] }) {
  const { colors, fonts } = useTheme();

  return (
    <View testID="recipe-steps" style={{ gap: 12 }}>
      {steps.map((step, index) => {
        const parsed = splitStep(step);
        return (
          <View
            key={`${index}-${step}`}
            testID={`recipe-step-${index}`}
            style={{
              flexDirection: "row",
              gap: 12,
              padding: 14,
              borderRadius: 14,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.accent,
                flexShrink: 0,
              }}
            >
              <Text
                style={{
                  color: colors.accentInk,
                  fontFamily: fonts.bodyStrong,
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
