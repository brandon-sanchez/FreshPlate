import { StyleSheet, Text, View } from "react-native";
import { useState } from "react";
import { useRouter } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";
import SegmentedControl from "@/components/SegmentedControl";
import BarcodeScanner from "@/components/BarcodeScanner";
import ItemForm from "@/components/ItemForm";
import { useTheme } from "@/hooks/useTheme";
import { useFoodCategories } from "@/hooks/useFoodCategories";
import { useAddItem } from "@/hooks/useAddItem";

type EntryMode = "Manual" | "Scan";

const ENTRY_MODES: EntryMode[] = ["Manual", "Scan"];

export default function AddItemScreen() {
  const { colors, fonts } = useTheme();
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const [mode, setMode] = useState<EntryMode>("Manual");

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          paddingTop: insets.top + 16,
          paddingHorizontal: 16,
          paddingBottom: 14,
          gap: 12,
          backgroundColor: colors.bg,
        }}
      >
        <Text
          style={[
            styles.title,
            { color: colors.text, fontFamily: fonts.display },
          ]}
        >
          Add Item
        </Text>
        <SegmentedControl
          options={ENTRY_MODES}
          selected={mode}
          onSelect={(option) => setMode(option as EntryMode)}
        />
      </View>

      {mode === "Manual" ? (
        <ManualForm tabBarHeight={tabBarHeight} />
      ) : (
        <View style={{ flex: 1, paddingBottom: tabBarHeight }}>
          {isFocused ? <BarcodeScanner /> : null}
        </View>
      )}
    </View>
  );
}

type ManualFormProps = {
  tabBarHeight: number;
};

function ManualForm({ tabBarHeight }: ManualFormProps) {
  const router = useRouter();
  const { data: categories } = useFoodCategories();
  const addItem = useAddItem();
  const [resetKey, setResetKey] = useState(0);

  return (
    <ItemForm
      categories={categories}
      resetKey={resetKey}
      submitLabel="Add to inventory"
      submittingLabel="Adding…"
      isSubmitting={addItem.isPending}
      contentContainerStyle={{ paddingBottom: tabBarHeight + 24 }}
      onSubmit={(input) => {
        const addedName = input.name;
        addItem.mutate(input, {
          onSuccess: ({ id, merged }) => {
            setResetKey((k) => k + 1);
            Toast.show({
              type: "success",
              text1: merged
                ? `Updated ${addedName}`
                : `Added ${addedName}`,
              text2: merged
                ? "Added to your existing item."
                : "Tap to view in your inventory.",
            });
            router.push({
              pathname: "/(tabs)/inventory",
              params: { added: id },
            });
          },
          onError: () => {
            Toast.show({
              type: "error",
              text1: "Couldn't save",
              text2: "Check your connection and try again.",
            });
          },
        });
      }}
    />
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
});
