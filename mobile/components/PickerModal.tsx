import { View, Text, Pressable, Modal, ScrollView } from "react-native";
import { useTheme } from "@/hooks/useTheme";

type PickerModalProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: string[];
  onSelect: (option: string) => void;
};

function PickerModal({
  visible,
  onClose,
  title,
  options,
  onSelect,
}: PickerModalProps) {
  const { colors, spacing } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        <View
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingHorizontal: spacing.xxl,
            paddingTop: spacing.xl,
            paddingBottom: 40,
            maxHeight: "70%",
          }}
        >
          <Text
            style={{
              fontSize: 18,
              fontWeight: "600",
              color: colors.text,
              marginBottom: spacing.lg,
            }}
          >
            {title}
          </Text>
          <ScrollView>
            {options.map((option) => (
              <Pressable
                style={{
                  paddingVertical: spacing.rowPad,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
                key={option}
                onPress={() => {
                  onSelect(option);
                  onClose();
                }}
              >
                <Text style={{ fontSize: 16, color: colors.text }}>{option}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            style={{ alignItems: "center", paddingVertical: spacing.lg, marginTop: spacing.sm }}
            onPress={onClose}
          >
            <Text style={{ fontSize: 16, color: colors.textMuted }}>{`Close`}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export default PickerModal;
