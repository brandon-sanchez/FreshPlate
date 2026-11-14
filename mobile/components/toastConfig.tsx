import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import Toast, { type ToastConfigParams } from "react-native-toast-message";
import { useTheme } from "@/hooks/useTheme";

type Tone = "success" | "error" | "info";

type UndoToastProps = {
  /** Runs after the toast hides when the user taps Undo. */
  onUndo: () => void;
};

const UNDO_WINDOW_MS = 5000;

type ToastRowProps = {
  tone: Tone;
  text1?: string;
  text2?: string;
  /** A text button on the right edge of the toast. */
  action?: { label: string; onPress: () => void };
};

function ToastRow({ tone, text1, text2, action }: ToastRowProps) {
  const { colors, fonts, card } = useTheme();
  const insets = useSafeAreaInsets();

  const accent =
    tone === "error" ? colors.crit : tone === "info" ? colors.textMuted : colors.accent;
  const iconName =
    tone === "error" ? "exclamation-circle" : tone === "info" ? "info-circle" : "check";

  return (
    <View
      style={{
        marginTop: insets.top + 6,
        marginHorizontal: 16,
        width: "auto",
        alignSelf: "stretch",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 14,
          paddingVertical: 12,
          paddingHorizontal: 14,
          shadowColor: card.shadowColor,
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.08,
          shadowRadius: 16,
          elevation: 6,
        }}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 100,
            backgroundColor:
              tone === "error" ? colors.surfaceAlt : colors.accentSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FontAwesome name={iconName as never} size={13} color={accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {text1 ? (
            <Text
              numberOfLines={1}
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 14,
                color: colors.text,
                letterSpacing: -0.2,
              }}
            >
              {text1}
            </Text>
          ) : null}
          {text2 ? (
            <Text
              numberOfLines={2}
              style={{
                fontFamily: fonts.body,
                fontSize: 12.5,
                color: colors.textMuted,
                marginTop: 2,
                letterSpacing: -0.05,
              }}
            >
              {text2}
            </Text>
          ) : null}
        </View>
        {action ? (
          <Pressable
            onPress={action.onPress}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <Text
              style={{
                fontFamily: fonts.bodyStrong,
                fontSize: 14,
                color: colors.accent,
                letterSpacing: -0.2,
              }}
            >
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Shows a success toast with an Undo button for five seconds.
 *
 * `onUndo` runs at most once: the toast keeps its button pressable while it
 * animates away, and a second tap must not send a second undo.
 *
 * @param toast.text1 - The headline, such as "Milk tossed".
 * @param toast.text2 - An optional detail line.
 * @param toast.onUndo - Reverses the action; runs after the toast hides.
 */
export function showUndoToast({
  text1,
  text2,
  onUndo,
}: {
  text1: string;
  text2?: string;
  onUndo: () => void;
}) {
  let undone = false;
  const props: UndoToastProps = {
    onUndo: () => {
      if (undone) return;
      undone = true;
      onUndo();
    },
  };
  Toast.show({ type: "undo", text1, text2, props, visibilityTime: UNDO_WINDOW_MS });
}

/**
 * Renders the app's top toasts: `success`, `error`, `info`, and `undo`, which
 * {@link showUndoToast} shows.
 */
export const toastConfig = {
  success: (props: ToastConfigParams<unknown>) => (
    <ToastRow tone="success" text1={props.text1} text2={props.text2} />
  ),
  error: (props: ToastConfigParams<unknown>) => (
    <ToastRow tone="error" text1={props.text1} text2={props.text2} />
  ),
  info: (props: ToastConfigParams<unknown>) => (
    <ToastRow tone="info" text1={props.text1} text2={props.text2} />
  ),
  undo: ({ text1, text2, hide, props }: ToastConfigParams<UndoToastProps>) => (
    <ToastRow
      tone="success"
      text1={text1}
      text2={text2}
      action={{
        label: "Undo",
        onPress: () => {
          hide();
          props.onUndo();
        },
      }}
    />
  ),
};
