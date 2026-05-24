import { create } from "zustand";

export type CenterToastTone = "success" | "danger" | "neutral";

export type CenterToastOptions = {
  icon: string;
  text: string;
  tone?: CenterToastTone;
  durationMs?: number;
};

type CenterToastState = {
  visible: boolean;
  icon: string;
  text: string;
  tone: CenterToastTone;
  durationMs: number;
  show: (opts: CenterToastOptions) => void;
  hide: () => void;
};

// Glanceable one-shot confirmation (auto-dismisses). Errors should use the top
// toast instead — those need to be read, not glanced at.
export const useCenterToast = create<CenterToastState>((set) => ({
  visible: false,
  icon: "check",
  text: "",
  tone: "success",
  durationMs: 1200,
  show: ({ icon, text, tone = "success", durationMs = 1200 }) =>
    set({ visible: true, icon, text, tone, durationMs }),
  hide: () => set({ visible: false }),
}));
