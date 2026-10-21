import { countLabel } from "@/lib/count-label";
// The operator's inbox posture and its one sentence: the pure answers Home's
// "Needs you" tile and the Wall's Needs you both read.

import type { OperatorPosture } from "@shared/wall";
import { isAmber } from "@shared/freshness";
import { WORK_POLL_CADENCE_HOURS } from "@shared/work";
import type { WorkWaiting } from "@/components/viz/WorkFlow";

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
 * The inbox in words: "3 urgent · 12 need attention", "Inbox unknown", "0 need attention".
 *
 * Beside `operatorState` so every surface says exactly the same sentence.
 * Partial counts use the shared lower-bound wording so unread projects do
 * not turn an observed count into an exact total.
 */
export function operatorLabel(operator: OperatorPosture, nowMs: number): string {
  const state = operatorState(operator, nowMs)!;
  const total = `${countLabel(operator.waiting, !state.complete)} need attention`;
  return operator.waiting > 0
    ? state.urgentComplete
      ? `${countLabel(operator.urgent)} urgent · ${total}`
      : operator.urgentMeasuredProjects > 0
        ? `${countLabel(operator.urgent, true)} urgent · ${total}`
        : `Urgency unknown · ${total}`
    : !state.complete
      ? "Inbox unknown"
      : state.stale
        ? "Inbox stale"
        : "0 need attention";
}

/**
 * The inbox as a figure the Wall draws ("Waiting on you", the loop's Decide):
 * null when no snapshot counted a project, a lower bound when some project
 * went uncounted, and stale when the snapshot is old, so neither ever draws a
 * zero it did not measure.
 */
export function operatorWaiting(operator: OperatorPosture | null | undefined, nowMs: number): WorkWaiting | null {
  const state = operatorState(operator, nowMs);
  if (!state || !operator || operator.capturedAt === null || operator.projectCount === 0) return null;
  return {
    count: operator.waiting,
    urgent: operator.urgent,
    partial: !state.complete || !state.urgentComplete,
    stale: state.stale,
  };
}
