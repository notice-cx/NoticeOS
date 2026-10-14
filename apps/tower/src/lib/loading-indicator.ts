import { useEffect, useState } from "react";

/**
 * When a loading indicator is drawn. `hidden` for the first `delay` ms of a
 * wait, so a fast load shows nothing; `shown` for at least `minVisible` ms
 * once drawn, so it never blinks; then `finishing` for `finish` ms while it
 * completes and fades, and `hidden` again.
 */
export type IndicatorPhase = "hidden" | "shown" | "finishing";

export interface IndicatorTiming {
  delay: number;
  minVisible: number;
  finish: number;
}

export const INDICATOR_TIMING: IndicatorTiming = { delay: 150, minVisible: 300, finish: 320 };

export interface LoadingIndicator {
  readonly phase: IndicatorPhase;
  /** Whether the thing it stands for is still loading. */
  set(busy: boolean): void;
  /** Stop every timer and start over from `hidden`. */
  dispose(): void;
}

export function createLoadingIndicator(
  onChange: (phase: IndicatorPhase) => void,
  { delay, minVisible, finish }: IndicatorTiming = INDICATOR_TIMING,
): LoadingIndicator {
  let phase: IndicatorPhase = "hidden";
  let busy = false;
  let shownAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const go = (next: IndicatorPhase) => {
    if (next === phase) return;
    phase = next;
    onChange(next);
  };
  const after = (ms: number, then: () => void) => {
    clearTimeout(timer);
    timer = setTimeout(then, ms);
  };
  const show = () => {
    shownAt = Date.now();
    go("shown");
  };

  return {
    get phase() {
      return phase;
    },
    set(next) {
      if (next === busy) return;
      busy = next;
      if (busy) {
        if (phase === "hidden") after(delay, show);
        else if (phase === "shown") clearTimeout(timer);
        else {
          clearTimeout(timer);
          show();
        }
        return;
      }
      if (phase === "hidden") {
        clearTimeout(timer);
        return;
      }
      if (phase === "shown") {
        after(Math.max(0, minVisible - (Date.now() - shownAt)), () => {
          go("finishing");
          after(finish, () => go("hidden"));
        });
      }
    },
    dispose() {
      clearTimeout(timer);
      busy = false;
      go("hidden");
    },
  };
}

/** `createLoadingIndicator` as a component's state. */
export function useLoadingIndicator(busy: boolean, timing: IndicatorTiming = INDICATOR_TIMING): IndicatorPhase {
  const [phase, setPhase] = useState<IndicatorPhase>("hidden");
  const [indicator] = useState(() => createLoadingIndicator(setPhase, timing));
  useEffect(() => indicator.set(busy), [busy, indicator]);
  useEffect(() => () => indicator.dispose(), [indicator]);
  return phase;
}
