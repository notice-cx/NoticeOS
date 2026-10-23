import { TASK_MEASURABILITY_LABELS, TASK_REVENUE_FAMILY_LABELS, type TaskCard } from "@noticeos/contract/task-card";
import { taskMetadataValue, type TaskMetadataName } from "@noticeos/contract/task-metadata";
import type { WeekMove, WorkProject } from "@shared/work";
import { formatInt, formatUsd } from "@/lib/format";
import type { BoardProject, BoardTask, InboxAsk } from "@/lib/task-board-read";
import type { HeldBackReason, RankedBoard, RankedTask, WhyPart } from "@/lib/task-ranking";
import { killDateLabel } from "@/components/viz/WhyItRanks";

/**
 * The words the Next tab, its brief and Focus build from one ranked board.
 * Pure, so each sentence is tested as a string; the components only seat them.
 */

/** The board read's filters when nothing narrows it: the Next tab ranks every
 * open task, and only All tasks reads filters from the URL. */
export const UNFILTERED = { project: "all", status: "all", priority: "all", label: "", assignee: "all" } as const;

/** The task page reads the rate under this name; `useOperatorRate.ts` is where it lives. */
export { operatorRateOf as operatorRate } from "@/hooks/useOperatorRate";

export function plural(count: number, one: string, many: string): string {
  return `${formatInt(count)} ${count === 1 ? one : many}`;
}

/** The button that answers an ask. */
export const ASK_VERB: Readonly<Record<InboxAsk, string>> = { approve: "Approve", answer: "Answer", choose: "Choose" };

/** The region's ask line. */
export const ASK_LINE: Readonly<Record<InboxAsk, string>> = {
  approve: "Needs your approval",
  answer: "Needs your answer",
  choose: "Needs your choice",
};

/** The sentence's lead: the kind of decision, never its title, which the
 * region under the sentence carries (a title can run to a paragraph). */
const ASK_LEAD: Readonly<Record<InboxAsk, string>> = { approve: "Approve one request", answer: "Answer one question", choose: "Choose one option" };

/** How long a decision has waited, short: `12d`, or the word for under a day. */
export function waitedShort(days: number | null): string | null {
  if (days === null) return null;
  return days >= 1 ? `${formatInt(days)}d` : "under a day";
}

/** A sentence's end, without doubling a title's own mark. */
export function endSentence(text: string): string {
  const trimmed = text.trim();
  return /[.?!…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function releasesClause(count: number, of: "this answer" | "it"): string {
  return `${plural(count, "task", "tasks")} ${count === 1 ? "waits" : "wait"} on ${of}`;
}

/** The money a card puts at stake each month, signed: `≈ +$640 /mo`. */
export function stakePerMonth(valuePerMonth: number): string {
  return `≈ ${valuePerMonth < 0 ? "−" : "+"}${formatUsd(Math.abs(valuePerMonth))} /mo`;
}

/** What the money figure sits over in a row: `70% likely · 10 min of you`. */
export function cardTerms(card: TaskCard): string {
  return `${Math.round(card.likelihood * 100)}% likely · ${card.reviewMinutes === 0 ? "none of you" : `${formatInt(card.reviewMinutes)} min of you`}`;
}

/**
 * The page's one sentence: what kind of decision comes first and the
 * strongest fact behind it, the money its card puts on it, else the work it
 * releases, else how long it has waited. The title is not in it: the region
 * under the sentence names the task, and a sentence that repeated it would
 * say the same thing twice.
 */
export function nextSentence(board: Pick<RankedBoard, "decisions" | "agents">, { complete }: { complete: boolean }): string {
  const top = board.decisions[0];
  if (top?.ask) {
    const lead = `${ASK_LEAD[top.ask]} first`;
    const clause = top.card !== null && top.score !== null
      ? `it holds about ${formatUsd(top.score.expectedPerMonth)} a month`
      : top.releases.length > 0
        ? releasesClause(top.releases.length, "it")
        : top.ageDays !== null && top.ageDays >= 1
          ? `it has waited ${plural(top.ageDays, "day", "days")}`
          : null;
    return clause === null ? `${lead}.` : `${lead}: ${clause}.`;
  }
  // A project nobody could read may hold decisions: never claim it does not.
  if (!complete) return "Couldn't read your decisions";
  const agent = board.agents[0];
  if (agent) return `Nothing waits on you. ${agent.task.title.trim()} is next for the agents.`;
  return "Nothing is queued.";
}

/** The decision's why as sentences, in the region: its note, what it
 * releases, its priority. The money and the wait have their own places. */
export function whySentence(parts: readonly WhyPart[]): string | null {
  const said: string[] = [];
  for (const kind of ["note", "releases", "priority"] as const) {
    const part = parts.find((entry) => entry.kind === kind);
    if (!part) continue;
    if (part.kind === "note") said.push(endSentence(part.text));
    if (part.kind === "releases") said.push(`${releasesClause(part.count, "this answer")}.`);
    if (part.kind === "priority") said.push(part.band === "top" ? "Top priority." : "High priority.");
  }
  return said.length === 0 ? null : said.join(" ");
}

/** A row's why in one muted line. `subject` names what an answer releases:
 * a decision's answer, or an agent's task. */
export function whyLine(parts: readonly WhyPart[], subject: "this answer" | "it"): string | null {
  const said = parts.flatMap((part): string[] => {
    if (part.kind === "note") return [part.text.trim().replace(/[.]$/u, "")];
    if (part.kind === "releases") return [releasesClause(part.count, subject)];
    if (part.kind === "priority") return [part.band === "top" ? "Top priority" : "High priority"];
    return [];
  });
  return said.length === 0 ? null : said.join(" · ");
}

/** One clause for the brief: the first fact the row holds. */
export function briefClause(row: RankedTask): string | null {
  for (const part of row.why) {
    if (part.kind === "note") return endSentence(capitalised(part.text));
    if (part.kind === "releases") return `${capitalised(releasesClause(part.count, "this answer"))}.`;
    if (part.kind === "expected") return `About ${formatUsd(part.perMonth)} a month is at stake.`;
    if (part.kind === "priority") return part.band === "top" ? "Top priority." : "High priority.";
  }
  return null;
}

/** Why a held-back task is held back, in one line. */
export function heldBackLine(reason: HeldBackReason): string {
  if (reason.kind === "blocked") {
    const first = reason.by[0];
    if (!first || first.title === null || first.title.trim() === "") return "Waits on another task";
    return reason.by.length > 1 ? `Waits on ${first.title.trim()} and ${formatInt(reason.by.length - 1)} more` : `Waits on ${first.title.trim()}`;
  }
  if (reason.kind === "parked") {
    const day = reason.until?.slice(0, 10) ?? null;
    return day ? `Parked until ${killDateLabel(day)}` : "Parked";
  }
  return `≈ ${formatUsd(reason.expectedPerMonth)} /mo, under the ${formatUsd(reason.costUsd)} its review costs`;
}

/** How a week's done count moved, in words, against last week by today. */
export function weekMoveWords(move: WeekMove): string {
  if (move.by === 0) return "level with last week by today";
  return `${formatInt(Math.abs(move.by))} ${move.by > 0 ? "more" : "fewer"} than last week by today`;
}

/** The brief's last fact: the week's done closes against last week. */
export function doneSentence(done: number, move: WeekMove | null): string {
  const lead = `${plural(done, "task", "tasks")} done this week`;
  return move ? `${lead}, ${weekMoveWords(move)}.` : `${lead}.`;
}

/** The figures a card holds that the strip leaves out, as label and value. */
export function cardDefinitions(card: TaskCard): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: "Predicted change", value: `${stakePerMonth(card.valuePerMonth)} · ${Math.round(card.likelihood * 100)}% likely` },
    {
      label: "Fully loaded cost",
      value: `${formatInt(card.reviewMinutes)} min of you${card.buildMinutes ? ` · about ${formatInt(Math.max(1, Math.round(card.buildMinutes / 60)))} h of build` : ""}`,
    },
  ];
  if (card.durability !== undefined) rows.push({ label: "Durability", value: `×${card.durability}` });
  if (card.kill) rows.push({ label: "Kill criterion", value: `${card.kill.state} → ${killDateLabel(card.kill.date)}` });
  rows.push({ label: "Measured as", value: TASK_MEASURABILITY_LABELS[card.measurability] });
  if (card.revenueFamily) rows.push({ label: "Revenue family", value: TASK_REVENUE_FAMILY_LABELS[card.revenueFamily] });
  return rows;
}

/** The finding a task was filed from, when its live row carries the handoff:
 * the site and the section of its page that raised it. */
export function cameFrom(task: BoardTask): { label: string; to: string } | null {
  const metadata = (task as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") return null;
  const text = (field: TaskMetadataName) => {
    const value = taskMetadataValue(metadata, field);
    return typeof value === "string" ? value.trim() : "";
  };
  const site = text("asset");
  if (site === "") return null;
  const section = ({ finding: ["#insights", "the findings"], query: ["#query-visibility", "the query decisions"], page: ["#page-decisions", "the page decisions"] } as const)[
    text("kind") as "finding" | "query" | "page"
  ] ?? null;
  return {
    label: `${section?.[1] ?? "the asset page"} on ${site}`,
    to: `/assets/${encodeURIComponent(site)}${section?.[0] ?? ""}`,
  };
}

/** When the holder took the task, else when it last moved. */
export function heldSince(task: BoardTask): string | null {
  const started = (task as { startedAt?: unknown }).startedAt;
  return typeof started === "string" && started !== "" ? started : task.updatedAt;
}

/** The epic a decision sits in, with its progress when the read carries it. */
export interface EpicFacts {
  id: string;
  title: string;
  closed: number | null;
  total: number | null;
}

/** The epic a task hangs off: its title from the project's read, its progress
 * from the project's saved counts when they hold it. */
export function epicOf(read: { byId: ReadonlyMap<string, BoardProject>; spokes: readonly WorkProject[] }, task: { project: string; parent: string | null }): EpicFacts | null {
  if (task.parent === null) return null;
  const title = read.byId.get(task.project)?.epicNames.get(task.parent);
  if (!title) return null;
  const counted = read.spokes.find((spoke) => spoke.asset === task.project)?.epics?.find((epic) => epic.id === task.parent);
  return { id: task.parent, title, closed: counted?.closed ?? null, total: counted?.total ?? null };
}
