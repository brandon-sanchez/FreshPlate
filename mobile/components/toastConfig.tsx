import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useTheme } from "@/hooks/useTheme";
import Toast, { useToastState, type ShownToast } from "@/lib/toast";

type Tone = "success" | "error" | "info";

type UndoToastProps = {
  /** Runs after the toast hides when the user taps Undo. */
  onUndo: () => void;
};

const UNDO_WINDOW_MS = 5000;
const EDGE_MARGIN = 16;
const MAX_TOAST_WIDTH = 340;
const STACK_GAP = 12;
const DISMISS_DRAG = 60;

type ToastRowProps = {
  tone: Tone;
  text1?: string;
  text2?: string;
  /** A text button on the right edge of the toast. */
  action?: { label: string; onPress: () => void };
};

function ToastRow({ tone, text1, text2, action }: ToastRowProps) {
  const { colors, fonts, card } = useTheme();
  const accent =
    tone === "error" ? colors.crit : tone === "info" ? colors.textMuted : colors.accent;
  const iconName =
    tone === "error" ? "exclamation-circle" : tone === "info" ? "info-circle" : "check";

  return (
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
  );
}

function once(run: () => void) {
  let ran = false;
  return () => {
    if (ran) return;
    ran = true;
    run();
  };
}

/**
 * Shows a success toast with an Undo button for five seconds.
 *
 * `onUndo` runs at most once.
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
  const props: UndoToastProps = { onUndo: once(onUndo) };
  Toast.show({ type: "undo", text1, text2, props, visibilityTime: UNDO_WINDOW_MS });
}

function rowFor(toast: ShownToast) {
  const { type = "success", text1, text2, props } = toast;
  if (type === "undo") {
    return (
      <ToastRow
        tone="success"
        text1={text1}
        text2={text2}
        action={{
          label: "Undo",
          onPress: () => {
            Toast.hide();
            props?.onUndo?.();
          },
        }}
      />
    );
  }
  return <ToastRow tone={type} text1={text1} text2={text2} />;
}

function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (event) => setHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

function useToastSlide(
  toastId: number | undefined,
  visible: boolean,
  offscreen: number,
) {
  const reducedMotion = useReducedMotion();
  const translateX = useRef(new Animated.Value(offscreen)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (toastId === undefined) return;
    if (visible) {
      translateX.setValue(reducedMotion ? 0 : offscreen);
      Animated.parallel([
        reducedMotion
          ? Animated.timing(translateX, { toValue: 0, duration: 0, useNativeDriver: true })
          : Animated.spring(translateX, {
              toValue: 0,
              stiffness: 260,
              damping: 26,
              mass: 0.8,
              useNativeDriver: true,
            }),
        Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: reducedMotion ? 0 : offscreen,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start();
    }
  }, [offscreen, opacity, reducedMotion, toastId, translateX, visible]);
  return { translateX, opacity };
}

type ToastHostProps = {
  /**
   * Points from the bottom of the screen that the toast must stay above while
   * the keyboard is closed: the top of the tab bar on tab screens, so the
   * toast never covers it, or the bottom safe-area inset elsewhere.
   */
  bottomInset: number;
};

/**
 * Draws the toast that {@link Toast} shows, sliding it in from the right to
 * the bottom right corner. A rightward swipe dismisses it, and it rides above
 * the keyboard while one is open.
 *
 * Mount one under the root navigator. A `Modal` covers the root, so a screen
 * that shows toasts inside one mounts its own host there too.
 */
export function ToastHost({ bottomInset }: ToastHostProps) {
  const { toast, visible } = useToastState();
  const keyboardHeight = useKeyboardHeight();
  const { width: windowWidth } = useWindowDimensions();
  const width = Math.min(windowWidth - EDGE_MARGIN * 2, MAX_TOAST_WIDTH);
  const offscreen = width + EDGE_MARGIN;

  const toastId = toast?.id;
  const { translateX, opacity } = useToastSlide(toastId, visible, offscreen);

  const text1 = toast?.text1;
  const text2 = toast?.text2;
  useEffect(() => {
    if (!visible) return;
    const message = [text1, text2].filter(Boolean).join(". ");
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }, [text1, text2, toastId, visible]);

  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        gesture.dx > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_event, gesture) =>
        translateX.setValue(Math.max(0, gesture.dx)),
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dx > DISMISS_DRAG || gesture.vx > 0.5) Toast.hide();
        else
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
      },
    }),
  ).current;

  if (!toast) return null;
  return (
    <Animated.View
      testID="toast"
      accessibilityLiveRegion="polite"
      pointerEvents={visible ? "box-none" : "none"}
      {...swipe.panHandlers}
      style={{
        position: "absolute",
        right: EDGE_MARGIN,
        bottom: Math.max(keyboardHeight, bottomInset) + STACK_GAP,
        width,
        opacity,
        transform: [{ translateX }],
      }}
    >
      {rowFor(toast)}
    </Animated.View>
  );
}
