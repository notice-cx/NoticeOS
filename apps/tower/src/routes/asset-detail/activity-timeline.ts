import type { AnnotationKind, WatchWindowItem } from "@shared/asset-detail";
import { lifecycleMoveSentence, parseLifecycleMoveRef } from "@shared/asset-detail";
import type { AnnotationItem } from "@shared/annotations";
import { isTaskId } from "@shared/tasks";
import { watchSeriesLabel } from "@shared/watch-windows";
import type { TimelineEvent, TimelineEventKind, TimelineLane } from "@/components/viz/EventTimeline";
import { taskPath } from "@/lib/task-path";
import { firstClause } from "@/routes/asset-detail/shared";

// What happened to a site and what is being judged because of it, on one axis
// that ends at now: every recorded change a mark on the Changes row, and every
// bet a mark where it was registered and another where its verdict came in, so
// a deploy and the verdict on it read left to right. A mark whose record names
// a task opens that task: a change its ref, a bet the task it watches, a
// verdict its readback task.

/** The mark's link, when the id it names is a task id. */
function taskHref(...ids: (string | null | undefined)[]): { href: string } | Record<string, never> {
  const id = ids.find(isTaskId);
  return id ? { href: taskPath(id) } : {};
}

/** How far back the picture reaches. */
export const ACTIVITY_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export const ACTIVITY_LANES: readonly TimelineLane[] = [
  { id: "changes", label: "Changes" },
  { id: "bets", label: "Bets" },
];

/** A change's mark: an incident is the one recorded event that is bad news;
 * a deploy or a setting is something shipped; the rest are notes. */
const CHANGE_MARK: Record<AnnotationKind, TimelineEventKind> = {
  deploy: "shipped",
  config: "shipped",
  "model-change": "shipped",
  "autonomy-change": "shipped",
  incident: "problem",
  external: "note",
};

/** A verdict's mark: a confirmed improvement is a win, a confirmed decline a
 * warning, and a verdict that could not tell is a note. */
function verdictMark(watch: WatchWindowItem): Pick<TimelineEvent, "kind" | "severity"> {
  if (watch.outcome === "ship_confirmed") return { kind: "win" };
  if (watch.outcome === "kill_confirmed") return { kind: "problem", severity: "warn" };
  return { kind: "note" };
}

const VERDICT_WORDS: Record<string, string> = {
  ship_confirmed: "improvement confirmed",
  kill_confirmed: "decline confirmed",
  inconclusive: "no clear change",
  unmeasurable: "could not be measured",
};

export function activityEvents(
  changes: readonly AnnotationItem[],
  watches: { open: readonly WatchWindowItem[]; closed: readonly WatchWindowItem[] },
  nowMs: number,
): TimelineEvent[] {
  const from = nowMs - ACTIVITY_WINDOW_DAYS * DAY_MS;
  const inWindow = (at: string | null): at is string => at !== null && Date.parse(at) >= from && Date.parse(at) <= nowMs;
  const events: TimelineEvent[] = [];
  for (const change of changes) {
    if (!inWindow(change.at)) continue;
    const move = parseLifecycleMoveRef(change.ref);
    const said = move ? lifecycleMoveSentence(move) : change.note;
    events.push({
      id: `change:${change.id}`,
      lane: "changes",
      at: change.at,
      kind: CHANGE_MARK[change.kind],
      ...(change.kind === "incident" ? { severity: "error" as const } : {}),
      label: said ? firstClause(said) : change.kind === "deploy" ? "Deploy" : "Change recorded",
      ...taskHref(change.ref),
    });
  }
  for (const watch of [...watches.open, ...watches.closed]) {
    const subject = watch.note ?? watchSeriesLabel(watch.metricIntegration, watch.metric);
    // An annotation ref is the change's own id, never a task's.
    const watched = watch.refKind === "annotation" ? null : watch.ref;
    if (inWindow(watch.registeredAt)) {
      events.push({ id: `watch:${watch.id}:start`, lane: "bets", at: watch.registeredAt, kind: "note", label: `Watching ${subject}`, ...taskHref(watched) });
    }
    if (watch.status === "closed" && inWindow(watch.closedAt)) {
      events.push({
        id: `watch:${watch.id}:verdict`,
        lane: "bets",
        at: watch.closedAt,
        ...verdictMark(watch),
        label: `${subject} · ${watch.outcome ? (VERDICT_WORDS[watch.outcome] ?? "verdict recorded") : "verdict recorded"}`,
        ...taskHref(watch.readbackTaskId, watched),
      });
    }
  }
  return events;
}
