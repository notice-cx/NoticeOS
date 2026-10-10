/**
 * WHAT A DATA SOURCE COSTS, HOW OFTEN IT RUNS, ITS LIMIT, AND WHAT HAPPENS WHEN
 * IT FAILS — as facts, not sentences (bead `ro-ujb9.96.6.2`).
 *
 * Each source used to carry two paragraphs copied from doc 11, "Usage limits"
 * and "On failure", which the Health page's audit grid printed under every
 * opened source. The operator reads four facts there, the way a sync tool
 * states a connection's schedule and volume; the methodology stays in
 * docs/11-integrations.md.
 */
export type LaneCost = "free" | "metered";

/** A source that runs on an event rather than on a schedule. A scheduled
 * source's cadence is not declared here: it is `collectionCadenceHours` in
 * `shared/integrations`, the same figure its freshness is judged against. */
export type LaneTrigger = "deploy" | "request" | "alert" | "failed-fetch";

/** What the OS does while a source is failing. */
export type LaneFailureMode =
  | "keeps-last-data"
  | "raises-alert"
  | "books-on-payment"
  | "pauses-deploy-marks"
  | "pauses-changes"
  | "falls-back-to-email"
  | "pauses-asset-checks";

export interface LaneUsage {
  /** Absent only for a lane the catalog added before the Worker knew it. */
  cost?: LaneCost;
  trigger?: LaneTrigger;
  /** The provider's own ceiling that shapes this source, as a figure. */
  limit?: string;
}

const COST: Record<LaneCost, string> = { free: "Free", metered: "Metered" };

const TRIGGER: Record<LaneTrigger, string> = {
  deploy: "On deploy",
  request: "On request",
  alert: "On alert",
  "failed-fetch": "After a failed fetch",
};

export const LANE_FAILURE_LABELS: Record<LaneFailureMode, string> = {
  "keeps-last-data": "Keeps last data",
  "raises-alert": "Raises an alert",
  "books-on-payment": "Books on payment",
  "pauses-deploy-marks": "Pauses deploy marks",
  "pauses-changes": "Pauses changes",
  "falls-back-to-email": "Falls back to email",
  "pauses-asset-checks": "Pauses site checks",
};

/** "Every 15 min", "Daily", "Weekly", "Every 6h". */
export function everyLabel(hours: number): string {
  if (hours === 24) return "Daily";
  if (hours === 168) return "Weekly";
  if (hours < 1) return `Every ${Math.round(hours * 60)} min`;
  if (hours % 24 === 0) return `Every ${hours / 24} days`;
  return `Every ${hours}h`;
}

export interface LaneFact {
  key: "cost" | "runs" | "limit" | "on-failure";
  /** The fact's name, shown small beside it. */
  name: string;
  value: string;
}

/** A source's facts in reading order, leaving out any it does not have.
 * `cadenceHours` is the lane's `collectionCadenceHours` — passed in, because
 * `shared/integrations` imports this module and a cycle back would not help. */
export function laneFacts(
  lane: { usage: LaneUsage; onFailure: LaneFailureMode | null },
  cadenceHours: number | null,
): LaneFact[] {
  const { cost, trigger, limit } = lane.usage;
  const runs = cadenceHours !== null ? everyLabel(cadenceHours) : trigger ? TRIGGER[trigger] : null;
  const facts: LaneFact[] = [];
  if (cost) facts.push({ key: "cost", name: "Cost", value: COST[cost] });
  if (runs) facts.push({ key: "runs", name: "Runs", value: runs });
  if (limit) facts.push({ key: "limit", name: "Limit", value: limit });
  if (lane.onFailure) facts.push({ key: "on-failure", name: "If it fails", value: LANE_FAILURE_LABELS[lane.onFailure] });
  return facts;
}
