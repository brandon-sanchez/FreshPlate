import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ROWS_HIDE_MS } from "@/lib/listMotion";

// Rows mounted per frame as the new grouping fills in. Each row takes a few
// milliseconds of JS to mount.
const FILL_STEP = 4;

type Phase = "hiding" | "emptying" | "filling";

type Job = {
  phase: Phase;
  direction: number;
  startedAt: number;
  cap: number;
  apply: () => void;
};

/** What {@link useRegroup} needs from the screen. */
export type RegroupOptions = {
  /** Starts hiding the rows, sliding them away from the chosen tab: 1 when it is right of the last one, -1 when left. */
  hide: (direction: number) => void;
  /** Starts showing the new grouping's rows, with the same direction. Runs in the commit that shows them, before it paints. */
  show: (direction: number) => void;
  /** Called once the old rows are hidden, just before they unmount. */
  onHidden?: () => void;
  /** How many rows to mount in steps before the list's own batching takes over, such as a screenful. */
  fillTo: number;
};

/**
 * Changes a list's grouping without one long frame. The list shows at most
 * `rowCap` rows, or every row when it is `null`.
 *
 * `regroup(from, to, apply)` hides the rows and waits for the fade to end.
 * It then empties the list in one commit, calls `apply` with the cap at 4
 * rows in the next, shows the rows, and raises the cap 4 rows a frame until
 * it reaches `fillTo` and lifts. Unmounting the old rows and mounting the
 * new ones in separate commits keeps each frame shorter. `from` and `to` are tab
 * indexes. Each step waits for the last one to commit, and a `regroup`
 * during another one replaces it.
 */
export function useRegroup({ hide, show, onHidden, fillTo }: RegroupOptions) {
  const [rowCap, setRowCap] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const job = useRef<Job | null>(null);
  const committedCap = useRef<number | null>(null);
  const frame = useRef(0);
  const latest = useRef({ show, onHidden, fillTo });
  latest.current = { show, onHidden, fillTo };

  useLayoutEffect(() => {
    committedCap.current = rowCap;
  }, [rowCap]);
  useLayoutEffect(() => {
    if (generation > 0) latest.current.show(job.current?.direction ?? 1);
  }, [generation]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const step = useCallback(() => {
    const current = job.current;
    if (!current) return;
    frame.current = requestAnimationFrame(step);
    // A step whose update hasn't committed yet would pile onto the next.
    if (current.phase !== "hiding" && committedCap.current !== current.cap)
      return;
    if (current.phase === "hiding") {
      if (performance.now() - current.startedAt < ROWS_HIDE_MS) return;
      latest.current.onHidden?.();
      current.phase = "emptying";
      current.cap = 0;
      startTransition(() => setRowCap(0));
      return;
    }
    if (current.phase === "emptying") {
      current.phase = "filling";
      current.cap = FILL_STEP;
      startTransition(() => {
        current.apply();
        setRowCap(FILL_STEP);
        setGeneration((count) => count + 1);
      });
      return;
    }
    const cap = current.cap + FILL_STEP;
    if (cap >= latest.current.fillTo) {
      job.current = null;
      cancelAnimationFrame(frame.current);
      startTransition(() => setRowCap(null));
      return;
    }
    current.cap = cap;
    startTransition(() => setRowCap(cap));
  }, []);

  const regroup = useCallback(
    (from: number, to: number, apply: () => void) => {
      const direction = Math.sign(to - from) || 1;
      hide(direction);
      job.current = {
        phase: "hiding",
        direction,
        startedAt: performance.now(),
        cap: FILL_STEP,
        apply,
      };
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(step);
    },
    [hide, step],
  );

  return { rowCap, regroup };
}
