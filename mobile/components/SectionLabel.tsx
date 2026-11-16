import { Text } from "react-native";
import { useTheme } from "@/hooks/useTheme";

type SectionLabelProps = {
  /** The label, shown uppercase. */
  text: string;
  /**
   * True when the label sits in a row beside other content, which drops the
   * margins that pull it close to the field below in a 16-gap column.
   */
  inline?: boolean;
};

/** Renders the small uppercase heading above a section of an editor screen. */
function SectionLabel({ text, inline = false }: SectionLabelProps) {
  const { colors, fonts } = useTheme();
  return (
    <Text
      style={{
        fontFamily: fonts.bodyStrong,
        fontSize: 11,
        color: colors.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginTop: inline ? 0 : 8,
        marginBottom: inline ? 0 : -8,
      }}
    >
      {text}
    </Text>
  );
}

export default SectionLabel;
