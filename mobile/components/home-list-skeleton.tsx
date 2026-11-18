import { View } from "react-native";
import { InventoryRowSkeleton } from "@/components/InventoryRow";
import { SkeletonBar, SkeletonPulse } from "@/components/skeleton";

const ROW_COUNT = 3;

/**
 * Holds Home's list area while the inventory loads, shaped like the Expired
 * and Use soon sections so the layout does not shift when they replace it.
 */
export default function HomeListSkeleton() {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your kitchen"
      accessibilityState={{ busy: true }}
    >
      <SkeletonPulse style={{ paddingTop: 24 }}>
        <View style={{ marginHorizontal: 20, marginBottom: 10, height: 15, justifyContent: "center" }}>
          <SkeletonBar width={72} height={11} radius={4} />
        </View>
        <View style={{ paddingHorizontal: 16, gap: 6 }}>
          {Array.from({ length: ROW_COUNT }, (_, index) => (
            <InventoryRowSkeleton key={index} />
          ))}
        </View>
      </SkeletonPulse>
    </View>
  );
}
