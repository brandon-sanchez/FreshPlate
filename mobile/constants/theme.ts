const lightColors = {
  bg: "#F5F3EE",
  surface: "#FFFFFF",
  surfaceAlt: "#EDEAE2",
  text: "#1B1F1C",
  textMuted: "#6A6F68",
  textSubtle: "#9A9E96",
  border: "#E2DED4",
  accent: "#2F5D4A",
  accentSoft: "#DCE8DE",
  accentInk: "#FFFFFF",
  warn: "#C87A2C",
  crit: "#B84438",
  ok: "#5B8A6A",
} as const;

const darkColors = {
  bg: "#141613",
  surface: "#1C1F1B",
  surfaceAlt: "#232621",
  text: "#EFEDE6",
  textMuted: "#9A9E96",
  textSubtle: "#6A6F68",
  border: "#2E3230",
  accent: "#7EB49A",
  accentSoft: "#243029",
  accentInk: "#0F1210",
  warn: "#E09A5A",
  crit: "#E27B72",
  ok: "#7EB49A",
} as const;

export type ColorTokens = typeof lightColors;

export const colors = {
  light: lightColors,
  dark: darkColors,
} as const;

export const fonts = {
  display: "Fraunces_500Medium",
  body: "Inter_400Regular",
  bodyStrong: "Inter_600SemiBold",
} as const;

export const spacing = {
  rowPad: 14,
  cardPad: 18,
  gap: 12,
  listGap: 10,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const card = {
  borderRadius: 16,
  shadowColor: "#000000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.04,
  shadowRadius: 16,
  elevation: 2,
} as const;

export type UrgencyLevel = "crit" | "warn" | "ok";

export interface UrgencyInfo {
  level: UrgencyLevel;
  label: string;
  progress: number;
}

export function getUrgency(daysUntilExpiration: number): UrgencyInfo {

  //assign level of urgency
  let level: UrgencyLevel
  if (daysUntilExpiration <= 1) {
    level = "crit";
  } else if (daysUntilExpiration <= 5 &&daysUntilExpiration >= 2) {
    level = "warn"
  } else {
    level = "ok"
  }

  // assign label
  let label: string;
  if (daysUntilExpiration < 0) {
    label = "Expired"
  } else if (daysUntilExpiration === 0) {
    label = "Today"
  } else if (daysUntilExpiration === 1) {
    label = "1 day"
  } else {
    label = `${daysUntilExpiration} days`;
  }

  //Calculate progress
  const progress = Math.max(0, Math.min(1, daysUntilExpiration / 14))

  return {level, label, progress}
}
