// The operator's inbox posture and its one sentence: the pure answers Home's
// "Needs you" tile and the Wall's Needs you both read.

import type { OperatorPosture } from "@shared/wall";
import { isAmber } from "@shared/freshness";
import { WORK_POLL_CADENCE_HOURS } from "@shared/work";

/**
 * What the operator's inbox posture IS, before anything renders it.
 *
 * `complete` says every photographed project supplied its count, `stale` says
 * the snapshot is older than 2× the poller's cadence, and `needsAttention` is
 * the one rule that decides warn tone versus healthy. A zero can read as calm
 * only when the snapshot earned it — an unmeasured or stale inbox is unknown,
 * never "nobody needs you".
 */
export function operatorState(operator: OperatorPosture | null | undefined, nowMs: number) {
  if (!operator) return null;
  const complete =
    operator.capturedAt !== null &&
    operator.projectCount > 0 &&
    operator.measuredProjects === operator.projectCount;
  const urgentComplete =
    operator.capturedAt !== null &&
    operator.projectCount > 0 &&
    operator.urgentMeasuredProjects === operator.projectCount;
  const stale = isAmber(nowMs, operator.capturedAt, WORK_POLL_CADENCE_HOURS);
  return {
    complete,
    urgentComplete,
    stale,
    needsAttention: operator.waiting > 0 || !complete || stale,
  };
}

/**
 * The inbox in words: "3 urgent · 12 need you", "Inbox unknown", "0 need you".
 *
 * Beside `operatorState` so every surface says exactly the same sentence. The
 * `+` suffixes are load-bearing — a partial snapshot renders a visible LOWER
 * BOUND rather than an exact-looking lie — which is precisely the nuance a
 * second hand-written copy of this sentence would lose.
 */
export function operatorLabel(operator: OperatorPosture, nowMs: number): string {
  const state = operatorState(operator, nowMs)!;
  const total = `${operator.waiting}${state.complete ? "" : "+"} need you`;
  return operator.waiting > 0
    ? state.urgentComplete
      ? `${operator.urgent} urgent · ${total}`
      : operator.urgentMeasuredProjects > 0
        ? `${operator.urgent}+ urgent · ${total}`
        : `Urgency unknown · ${total}`
    : !state.complete
      ? "Inbox unknown"
      : state.stale
        ? "Inbox stale"
        : "0 need you";
}
