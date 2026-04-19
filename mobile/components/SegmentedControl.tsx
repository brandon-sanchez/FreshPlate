import { Text, View, Pressable, StyleSheet } from "react-native";

type SegmentedControlProps = {
  options: string[];
  selected: string;
  onSelect: (option: string) => void;
};

function SegmentedControl({
  options,
  selected,
  onSelect,
}: SegmentedControlProps) {
  return (
    <View style={styles.container}>
      {options.map((option) => (
        <Pressable
          style={[styles.segment, option === selected && styles.segmentActive]}
          key={option}
          onPress={() => onSelect(option)}
        >
          <Text style={[styles.segmentText, option === selected && styles.segmentTextActive]}>
            {option}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    height: 44,
    borderRadius: 10,
    overflow: "hidden",
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center", 
    backgroundColor: "#F0EFEB"
  },
  segmentActive: {
    backgroundColor: "#2D6A4F",
  },
  segmentTextActive: {
    color: "#FFFFFF"
  },
  segmentText: {
    color: "#3D3D38",
    fontWeight: "600",
    fontSize: 14
  }
});

export default SegmentedControl;
