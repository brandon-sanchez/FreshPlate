import { View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { getUrgency } from "@/constants/theme";

type UrgencyBarProps = {
  daysUntilExpiration: number | null;
  width?: number;
};

function UrgencyBar({ daysUntilExpiration, width = 60 }: UrgencyBarProps) {
  const { colors } = useTheme();

  if (daysUntilExpiration === null) {
    return (
      <View
        style={{
          width,
          height: 4,
          borderRadius: 2,
          backgroundColor: colors.surfaceAlt,
        }}
      />
    );
  }

  const { level, progress } = getUrgency(daysUntilExpiration);
  const barColor =
    level === "crit" ? colors.crit : level === "warn" ? colors.warn : colors.ok;
  const trackColor = colors.surfaceAlt;
  const fillProgress = daysUntilExpiration < 0 ? 1 : progress;

  return (
    <View
      style={{
        width,
        height: 4,
        borderRadius: 2,
        backgroundColor: trackColor,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.max(8, fillProgress * 100)}%`,
          height: "100%",
          backgroundColor: barColor,
          borderRadius: 2,
        }}
      />
    </View>
  );
}

export default UrgencyBar;
