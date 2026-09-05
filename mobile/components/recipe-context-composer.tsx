import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { card } from "@/constants/theme";
import { RecipePressable } from "@/components/recipe-motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";

type RecipeContextComposerProps = {
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  testID?: string;
  placeholder?: string;
};

// Adapted from @jahed's 21st AI Chat Input: expanding text area and round send action.
export default function RecipeContextComposer({
  value,
  onChangeText,
  onSubmit,
  testID,
  placeholder = "A craving, an occasion, a little context...",
}: RecipeContextComposerProps) {
  const { colors, fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const expanded = focused || value.length > 0;
  const height = useRef(new Animated.Value(expanded ? 168 : 64)).current;
  const hasValue = value.trim().length > 0;

  useEffect(() => {
    if (reducedMotion) {
      height.setValue(expanded ? 168 : 64);
      return;
    }
    const animation = Animated.timing(height, {
      toValue: expanded ? 168 : 64,
      duration: 400,
      easing: Easing.bezier(0.175, 0.885, 0.32, 1.275),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [expanded, height, reducedMotion]);

  const submit = () => {
    if (hasValue) onSubmit();
  };

  return (
    <Animated.View
      style={[
        styles.container,
        {
          height,
          backgroundColor: colors.surface,
          borderColor: focused ? colors.accent : colors.border,
        },
      ]}
    >
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={expanded ? placeholder : "Add a little context..."}
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Occasion or recipe context"
        accessibilityHint="Optional. Used for this recipe session only."
        multiline
        maxLength={160}
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={submit}
        textAlignVertical="top"
        style={[
          styles.input,
          expanded && styles.expandedInput,
          { color: colors.text, fontFamily: fonts.body },
        ]}
      />
      {expanded ? (
        <View style={styles.footer} pointerEvents="none">
          <Text
            style={[
              styles.caption,
              { color: colors.textMuted, fontFamily: fonts.body },
            ]}
          >
            Just for this session
          </Text>
          <Text
            accessibilityLabel={`${value.length} of 160 characters`}
            style={[
              styles.caption,
              { color: colors.textMuted, fontFamily: fonts.body },
            ]}
          >
            {value.length}/160
          </Text>
        </View>
      ) : null}
      <RecipePressable
        onPress={submit}
        disabled={!hasValue}
        testID={testID ? `${testID}-send` : undefined}
        accessibilityRole="button"
        accessibilityLabel="Generate recipes with this context"
        accessibilityState={{ disabled: !hasValue }}
        style={[
          styles.sendButton,
          { backgroundColor: hasValue ? colors.accent : colors.surfaceAlt },
        ]}
      >
        <Feather
          name="arrow-up"
          size={20}
          color={hasValue ? colors.accentInk : colors.textMuted}
        />
      </RecipePressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...card,
    borderWidth: 1,
    borderRadius: 24,
    overflow: "hidden",
  },
  input: {
    flex: 1,
    minHeight: 62,
    paddingTop: 20,
    paddingBottom: 16,
    paddingLeft: 18,
    paddingRight: 66,
    fontSize: 14,
    lineHeight: 22,
  },
  expandedInput: { paddingRight: 18, marginBottom: 60 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 18,
    right: 70,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  caption: { fontSize: 12, lineHeight: 16 },
  sendButton: {
    position: "absolute",
    bottom: 9,
    right: 9,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
