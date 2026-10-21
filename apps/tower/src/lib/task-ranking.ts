import { readTaskCard, scoreTaskCard, TASK_CARD_POLICY, type TaskCard, type TaskCardScore } from "@noticeos/contract/task-card";
import { TASK_BLOCKING_DEPENDENCIES } from "@noticeos/contract/task-gate";
import { IN_PROGRESS, PARKED, askVerb, inboxOrder, isGate, type BoardTask, type InboxAsk } from "./task-board-read";

/**
 * The board's answer to "what next, and why": the operator's decisions, the
 * agents' next work and everything held back, each row with its reason.
 *
 * Policy v1.0 (docs/04) ranks a task by its card: expected change a month over
 * the review cost and the weeks to signal. A task without a card is listed
 * after the ranked ones in the board's own order (what an answer releases,
 * priority, age), never given an invented score. Nothing here is stored: a
 * ranking is re-read from the rows every time, with the policy version beside
 * it.
 */

/** Phrases a row's why is built from, shortest first; the screen joins them. */
export type WhyPart =
  | { kind: "note"; text: string }
  | { kind: "releases"; count: number; titles: string[] }
  | { kind: "waiting"; days: number }
  | { kind: "priority"; band: "top" | "high" }
  | { kind: "expected"; perMonth: number }
  | { kind: "no-card" };

export interface RankedTask {
  task: BoardTask;
  /** What the operator does with it, or null for the agents' work. */
  ask: InboxAsk | null;
  card: TaskCard | null;
  score: TaskCardScore | null;
  /** 1-based, within its list. */
  rank: number;
  why: WhyPart[];
  /** The work an answer releases (the board's `decisionImpact`). */
  releases: { id: string; title: string }[];
  /** Days since the task was filed, or since it last moved when the filing
   * date is not known; null when neither is. */
  ageDays: number | null;
  /** For the agents' list: already being worked, or claimable now. */
  state: "in-progress" | "ready" | "asked";
}

export type HeldBackReason =
  | { kind: "blocked"; by: { id: string; title: string | null }[] }
  | { kind: "parked"; until: string | null }
  | { kind: "below-cost"; expectedPerMonth: number; costUsd: number };

export interface HeldBackTask {
  task: BoardTask;
  reason: HeldBackReason;
  card: TaskCard | null;
}

export interface RankedBoard {
  decisions: RankedTask[];
  agents: RankedTask[];
  notNow: HeldBackTask[];
  /** How many rows carry a card: the ranking's coverage, shown beside it. */
  carded: number;
  rated: number;
  operatorRateUsdPerMin: number;
  policy: typeof TASK_CARD_POLICY;
}

const DAY_MS = 86_400_000;

/** A row's card: the one the read already parsed, else the one in its live
 * metadata (a detail read keeps `metadata`; a board row keeps `card`). */
export function cardOf(task: BoardTask): TaskCard | null {
  if (task.card !== undefined) return task.card;
  const metadata = (task as { metadata?: unknown }).metadata;
  return metadata === undefined ? null : readTaskCard(metadata);
}

export function taskAgeDays(task: Pick<BoardTask, "createdAt" | "updatedAt">, now: Date): number | null {
  const stamp = task.createdAt ?? task.updatedAt ?? null;
  const parsed = stamp === null ? Number.NaN : Date.parse(stamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed) / DAY_MS));
}

function blockedBy(task: BoardTask): { id: string; title: string | null }[] {
  return (task.dependencies ?? [])
    .filter((edge) => TASK_BLOCKING_DEPENDENCIES.includes(edge.type) && edge.status !== "closed")
    .map((edge) => ({ id: edge.id, title: edge.title }));
}

function whyOf(task: BoardTask, card: TaskCard | null, score: TaskCardScore | null, ageDays: number | null): WhyPart[] {
  const parts: WhyPart[] = [];
  if (card?.note) parts.push({ kind: "note", text: card.note });
  const releases = task.decisionImpact?.proceeds ?? [];
  if (releases.length > 0) parts.push({ kind: "releases", count: releases.length, titles: releases.map((row) => row.title) });
  if (score !== null) parts.push({ kind: "expected", perMonth: score.expectedPerMonth });
  if (task.priority <= 1) parts.push({ kind: "priority", band: task.priority === 0 ? "top" : "high" });
  if (ageDays !== null && ageDays >= 1) parts.push({ kind: "waiting", days: ageDays });
  if (card === null) parts.push({ kind: "no-card" });
  return parts;
}

/** Score first, highest first; then the board's own order for the rest. */
function rankedOrder(a: { task: BoardTask; score: TaskCardScore | null }, b: { task: BoardTask; score: TaskCardScore | null }): number {
  if (a.score !== null && b.score !== null && a.score.score !== b.score.score) return b.score.score - a.score.score;
  if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
  return inboxOrder(a.task, b.task);
}

function open(task: BoardTask): boolean {
  return task.status !== "closed" && task.status !== PARKED && task.issueType !== "epic";
}

/**
 * Rank one board. `inbox` is what the board already decided waits on the
 * operator (its `inboxOrder` applied); `tasks` is every row it drew. The two
 * lists are the same rows the board shows, so a decision never appears twice.
 */
export function rankBoard({ tasks, inbox, operatorRateUsdPerMin, now = new Date() }: {
  tasks: readonly BoardTask[];
  inbox: readonly BoardTask[];
  operatorRateUsdPerMin: number;
  now?: Date;
}): RankedBoard {
  const scoring = { operatorRateUsdPerMin };
  let carded = 0;
  const describe = (task: BoardTask, state: RankedTask["state"]): Omit<RankedTask, "rank"> => {
    const card = cardOf(task);
    if (card !== null) carded += 1;
    const score = card === null ? null : scoreTaskCard(card, scoring);
    const ageDays = taskAgeDays(task, now);
    return {
      task, card, score, ageDays, state,
      ask: state === "asked" ? askVerb(task) : null,
      why: whyOf(task, card, score, ageDays),
      releases: (task.decisionImpact?.proceeds ?? []).map((row) => ({ id: row.id, title: row.title })),
    };
  };
  const asked = new Set(inbox.map((task) => task.id));
  const decisions = inbox.map((task) => describe(task, "asked")).sort(rankedOrder)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  const notNow: HeldBackTask[] = [];
  const agentRows: Omit<RankedTask, "rank">[] = [];
  for (const task of tasks) {
    if (asked.has(task.id) || !open(task)) {
      if (task.status === PARKED && !asked.has(task.id) && task.issueType !== "epic") {
        notNow.push({ task, card: cardOf(task), reason: { kind: "parked", until: task.deferUntil } });
      }
      continue;
    }
    // A gate is a wait, not work; a human one is already in the inbox and any
    // other resolves itself.
    if (isGate(task)) continue;
    if (task.status === IN_PROGRESS) {
      agentRows.push(describe(task, "in-progress"));
      continue;
    }
    if (task.status === "blocked" || !task.ready) {
      notNow.push({ task, card: cardOf(task), reason: { kind: "blocked", by: blockedBy(task) } });
      continue;
    }
    const row = describe(task, "ready");
    if (row.score !== null && row.score.expectedPerMonth < row.score.costUsd) {
      notNow.push({ task, card: row.card, reason: { kind: "below-cost", expectedPerMonth: row.score.expectedPerMonth, costUsd: row.score.costUsd } });
      continue;
    }
    agentRows.push(row);
  }
  // What is being worked stays at the top: it is what the agents are doing
  // now, and a ranking must not read as a suggestion to drop it.
  const agents = agentRows
    .sort((a, b) => (a.state !== b.state ? (a.state === "in-progress" ? -1 : 1) : rankedOrder(a, b)))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    decisions, agents, notNow,
    carded,
    rated: decisions.length + agents.length,
    operatorRateUsdPerMin,
    policy: TASK_CARD_POLICY,
  };
}
