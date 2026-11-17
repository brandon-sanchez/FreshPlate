import { RefObject, useEffect, useRef } from "react";
import { Keyboard, Platform, ScrollView, View } from "react-native";

/**
 * Keeps a view inside a scroll view `gap` points above the iOS keyboard while
 * one of its fields has focus. Wire the returned `onFocus` and `onBlur` to
 * those fields.
 *
 * Each time the keyboard opens or changes size during focus, `scrollRef`
 * scrolls so the bottom of `targetRef` sits `gap` points above the keyboard.
 * The scroll view's `automaticallyAdjustKeyboardInsets` brings only the focused
 * field into view, flush against the keyboard, so anything below the field
 * stays hidden without this. Does nothing on Android, where that prop doesn't
 * exist.
 *
 * @param scrollRef - The scroll view that contains `targetRef`. It must start
 *   at the top of the window, because React Native measures the keyboard in
 *   window coordinates.
 * @param targetRef - The view to keep above the keyboard, such as the card
 *   around the field.
 * @param gap - Space between the view's bottom edge and the keyboard, in points.
 */
export function useScrollAboveKeyboard(
  scrollRef: RefObject<ScrollView | null>,
  targetRef: RefObject<View | null>,
  gap: number,
) {
  const focused = useRef(false);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    // keyboardDidShow fires after the scroll view's own keyboard scroll ends,
    // and again whenever the keyboard changes size, so this scroll lands last.
    const subscription = Keyboard.addListener("keyboardDidShow", () => {
      const target = targetRef.current;
      if (!focused.current || !target) return;
      scrollRef.current?.scrollResponderScrollNativeHandleToKeyboard(
        target,
        gap,
        true,
      );
    });
    return () => subscription.remove();
  }, [scrollRef, targetRef, gap]);

  return {
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
    },
  };
}
