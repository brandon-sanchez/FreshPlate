import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";

type ScanViewfinderProps = {
  width?: number;
  height?: number;
  /** When false, the sweeping scan line is hidden (e.g. after a successful scan). */
  scanning?: boolean;
};

const VIEWFINDER_WIDTH = 220;
const VIEWFINDER_HEIGHT = 140;
const CORNER_SIZE = 24;
const CORNER_THICKNESS = 3;

function ScanViewfinder({
  width = VIEWFINDER_WIDTH,
  height = VIEWFINDER_HEIGHT,
  scanning = true,
}: ScanViewfinderProps) {
  const { colors } = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!scanning) {
      progress.value = 0;
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [scanning, progress]);

  const lineStyle = useAnimatedStyle(() => {
    const travel = height - 16;
    return {
      transform: [{ translateY: progress.value * travel }],
    };
  });

  return (
    <View
      style={{
        width,
        height,
        borderRadius: 16,
        borderWidth: 2,
        borderColor: "rgba(255,255,255,0.15)",
        position: "relative",
      }}
    >
      {/* Corner brackets */}
      <View
        style={{
          position: "absolute",
          top: -CORNER_THICKNESS,
          left: -CORNER_THICKNESS,
          width: CORNER_SIZE,
          height: CORNER_SIZE,
          borderColor: colors.accent,
          borderTopWidth: CORNER_THICKNESS,
          borderLeftWidth: CORNER_THICKNESS,
          borderTopLeftRadius: 8,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: -CORNER_THICKNESS,
          right: -CORNER_THICKNESS,
          width: CORNER_SIZE,
          height: CORNER_SIZE,
          borderColor: colors.accent,
          borderTopWidth: CORNER_THICKNESS,
          borderRightWidth: CORNER_THICKNESS,
          borderTopRightRadius: 8,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: -CORNER_THICKNESS,
          left: -CORNER_THICKNESS,
          width: CORNER_SIZE,
          height: CORNER_SIZE,
          borderColor: colors.accent,
          borderBottomWidth: CORNER_THICKNESS,
          borderLeftWidth: CORNER_THICKNESS,
          borderBottomLeftRadius: 8,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: -CORNER_THICKNESS,
          right: -CORNER_THICKNESS,
          width: CORNER_SIZE,
          height: CORNER_SIZE,
          borderColor: colors.accent,
          borderBottomWidth: CORNER_THICKNESS,
          borderRightWidth: CORNER_THICKNESS,
          borderBottomRightRadius: 8,
        }}
      />

      {scanning ? (
        <Animated.View
          style={[
            {
              position: "absolute",
              left: 10,
              right: 10,
              top: 8,
              height: 2,
              backgroundColor: colors.accent,
              shadowColor: colors.accent,
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: 0.8,
              shadowRadius: 6,
              elevation: 4,
            },
            lineStyle,
          ]}
        />
      ) : null}
    </View>
  );
}

export default ScanViewfinder;
