import { create } from "zustand";

/** The toast styles that `ToastHost` knows how to draw. */
export type ToastType = "success" | "error" | "info" | "undo";

/** What to show in a toast. */
export type ToastShowParams = {
  /** Picks the icon and color. Defaults to `success`. */
  type?: ToastType;
  /** The headline, such as "Saved". */
  text1?: string;
  /** An optional detail line under the headline. */
  text2?: string;
  /** How long the toast stays up, in milliseconds. Defaults to 4000. */
  visibilityTime?: number;
  /** Extra data for the toast type; `undo` reads `onUndo` from it. */
  props?: { onUndo?: () => void };
};

/** A shown toast, with an id that changes on every {@link Toast.show}. */
export type ShownToast = ToastShowParams & { id: number };

const DEFAULT_VISIBILITY_MS = 4000;

type ToastState = {
  /** The latest toast, kept after it hides so the host can animate it out. */
  toast: ShownToast | null;
  visible: boolean;
};

const useToastStore = create<ToastState>(() => ({
  toast: null,
  visible: false,
}));

let nextId = 1;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Returns the current toast and whether it is showing, for `ToastHost`.
 */
export function useToastState(): ToastState {
  const toast = useToastStore((s) => s.toast);
  const visible = useToastStore((s) => s.visible);
  return { toast, visible };
}

/**
 * Shows and hides the app's toast. One toast shows at a time: a new one
 * replaces the one on screen and restarts the timer.
 */
const Toast = {
  /** Shows `params` until its visibility time runs out or {@link Toast.hide} runs. */
  show(params: ToastShowParams) {
    clearTimeout(hideTimer);
    useToastStore.setState({ toast: { ...params, id: nextId++ }, visible: true });
    hideTimer = setTimeout(
      Toast.hide,
      params.visibilityTime ?? DEFAULT_VISIBILITY_MS,
    );
  },
  /** Hides the toast on screen, if any. */
  hide() {
    clearTimeout(hideTimer);
    useToastStore.setState({ visible: false });
  },
};

export default Toast;
