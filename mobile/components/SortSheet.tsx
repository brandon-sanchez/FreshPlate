import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/hooks/useTheme";
import { SORT_OPTIONS, sortLabel, type SortBy } from "@/lib/foodSort";

type SortSheetProps = {
  /** Shows the sheet. */
  visible: boolean;
  /** The sort in effect, marked with a check. */
  selected: SortBy;
  /** Called with the tapped sort; the sheet then closes through `onClose`. */
  onSelect: (sortBy: SortBy) => void;
  /** Called when the sheet should hide: after a pick, a backdrop tap or the system back gesture. */
  onClose: () => void;
};

/** A bottom sheet listing the inventory sorts as a single-choice list. */
export default function SortSheet({
  visible,
  selected,
  onSelect,
  onClose,
}: SortSheetProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close sort options"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: "rgba(0,0,0,0.4)" },
          ]}
        />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
          }}
        >
          <View
            style={{
              width: 40,
              height: 4,
              backgroundColor: colors.border,
              borderRadius: 2,
              alignSelf: "center",
              marginBottom: 14,
            }}
          />
          <Text
            accessibilityRole="header"
            style={{
              fontFamily: fonts.display,
              fontSize: 22,
              letterSpacing: -0.4,
              color: colors.text,
            }}
          >
            Sort
          </Text>
          <Text
            style={{
              fontFamily: fonts.body,
              fontSize: 13,
              color: colors.textMuted,
              marginTop: 4,
              marginBottom: 10,
            }}
          >
            Applies inside each section.
          </Text>

          <View accessibilityRole="radiogroup">
            {SORT_OPTIONS.map((value, index) => {
              const label = sortLabel(value);
              const checked = value === selected;
              return (
                <Pressable
                  key={value}
                  onPress={() => {
                    onSelect(value);
                    onClose();
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    minHeight: 48,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: colors.border,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text
                    style={{
                      flex: 1,
                      fontFamily: checked ? fonts.bodyStrong : fonts.body,
                      fontSize: 15,
                      color: checked ? colors.accent : colors.text,
                    }}
                  >
                    {label}
                  </Text>
                  {checked ? (
                    <FontAwesome name="check" size={14} color={colors.accent} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}
