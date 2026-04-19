import { useColorScheme } from "react-native";
import { colors, fonts, spacing, card } from "@/constants/theme"

export function useTheme() {
  const colorScheme = useColorScheme() ?? "light"

  return { colors: colors[colorScheme], fonts, spacing, card, colorScheme}
}
