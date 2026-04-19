import { View, Text, Pressable, Modal, StyleSheet } from "react-native";

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
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          {options.map((option) => (
            <Pressable
              style={styles.option}
              key={option}
              onPress={() => {
                onSelect(option);
                onClose();
              }}
            >
              <Text style={styles.optionText}>{option}</Text>
            </Pressable>
          ))}

          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export default PickerModal;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1a1a1a",
    marginBottom: 16,
  },
  option: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F0EFEB",
  },
  optionText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  closeButton: {
    alignItems: "center",
    paddingVertical: 16,
    marginTop: 8,
  },
  closeText: {
    fontSize: 16,
    color: "#7A7A72",
  },
});
