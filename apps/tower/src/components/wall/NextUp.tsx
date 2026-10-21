import { CircleCheck, Zap } from "lucide-react";
import type { AssetCard, OperatorPosture, WallDecision, WallDecisionAsk, WallNextUp, WallWorking } from "@shared/wall";
import { sumWorkWeeks } from "@shared/work";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { LAST_WEEK_BY_TODAY, WorkWeekChip } from "@/components/viz/WorkFlow";
import { formatInt } from "@/lib/format";
import { operatorState } from "@/lib/operator-posture";
import { cn } from "@/lib/utils";

// Next up on the TV: how many decisions wait on the operator, the top one by
// name, the four after it as site marks with their ages, and beside them what
// is held now and the week's done. Read-only. A count the snapshot did not
// measure is a word, never a zero, by the rule Needs attention reads.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

/** The Tasks page's words for each ask, read out to a screen reader. */
const ASK_WORDS: Record<WallDecisionAsk, string> = {
  approve: "Needs your approval",
  answer: "Needs your answer",
  choose: "Needs your choice",
};

export interface NextUpProps {
  next: WallNextUp | null | undefined;
  /** The inbox's counts; null or absent stays unknown, never zero. */
  operator: OperatorPosture | null | undefined;
  /** The sites on the TV: each row's name and mark. */
  assets: readonly AssetCard[];
  /** The sites in Work this week, whose weeks the done figure sums, so it is
   * the figure Work this week shows. */
  workAssets: readonly AssetCard[];
  /** Sites whose TV switch is off; their decisions and work are left out. */
  hidden?: ReadonlySet<string>;
  nowMs: number;
}

export type DecisionsFigure =
  | { kind: "count"; count: number; text: string; partial: boolean }
  | { kind: "word"; text: string };

/**
 * The decisions figure, as Needs attention words an inbox count: a lower
 * bound ("3+") when a project went uncounted, "Tasks unknown" when nothing
 * was, and an old zero is "Tasks out of date" rather than calm. A count above
 * zero is a count however old the reading.
 */
export function decisionsFigure(operator: OperatorPosture | null | undefined, nowMs: number): DecisionsFigure {
  const state = operatorState(operator, nowMs);
  if (!state || !operator || operator.capturedAt === null || operator.projectCount === 0) {
    return { kind: "word", text: "Tasks unknown" };
  }
  if (!state.complete) {
    return operator.waiting > 0
      ? { kind: "count", count: operator.waiting, text: `${formatInt(operator.waiting)}+`, partial: true }
      : { kind: "word", text: "Tasks unknown" };
  }
  if (operator.waiting === 0 && state.stale) return { kind: "word", text: "Tasks out of date" };
  return { kind: "count", count: operator.waiting, text: formatInt(operator.waiting), partial: false };
}

/** How long a decision has waited, in words: "under a day", "1 day", "9 days". */
export function daysWaited(days: number): string {
  if (days === 0) return "under a day";
  return `${formatInt(days)} ${days === 1 ? "day" : "days"}`;
}

/** The top decision's line, each clause only where the reading has it. */
export function decisionLine(decision: WallDecision, site: string): string {
  return [
    site,
    decision.ageDays === null ? null : daysWaited(decision.ageDays),
    decision.releases === null || decision.releases === 0
      ? null
      : `holds ${formatInt(decision.releases)} ${decision.releases === 1 ? "task" : "tasks"}`,
  ].filter((clause): clause is string => clause !== null).join(" · ");
}

/** A held task's line: the site, who holds it and for how long. */
export function workingLine(working: WallWorking, site: string): string {
  return [site, working.who, working.sinceHours === null ? null : `${formatInt(working.sinceHours)}h in`]
    .filter((clause): clause is string => clause !== null && clause !== "")
    .join(" · ");
}

export function NextUp({ next, operator, assets, workAssets, hidden, nowMs }: NextUpProps) {
  const cards = new Map(assets.map((asset) => [asset.id, asset]));
  const siteOf = (asset: string) => cards.get(asset)?.displayName ?? asset;
  const shown = (asset: string) => !hidden?.has(asset);
  const decisions = (next?.decisions ?? []).filter((decision) => shown(decision.asset));
  const working = (next?.working ?? []).filter((row) => shown(row.asset));
  const figure = decisionsFigure(operator, nowMs);
  const [top, ...rest] = decisions;
  const calm = figure.kind === "count" && figure.count === 0 && decisions.length === 0;
  const weeks = sumWorkWeeks(workAssets.filter((asset) => asset.work).map((asset) => asset.work!.weeks));
  const done = weeks?.done.now ?? null;

  return (
    <section aria-label="Next up" className="@container flex h-full min-h-0 min-w-0 flex-col" data-wall-next="">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-y-wall-region @xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-wall-region @xl:pe-wall-region-x" data-next-decisions="">
          <div className="flex min-w-0 flex-col">
            <h2 className={eyebrow}>Needs you</h2>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-4" data-material-condition="human-gates">
              {figure.kind === "count" ? (
                <>
                  <span
                    className={cn("text-wall-display font-bold tracking-tighter tabular-nums", figure.count > 0 ? "text-warn" : "text-foreground")}
                    data-next-count={figure.text}
                  >
                    {figure.text}
                  </span>
                  <span className="text-wall-body text-muted-foreground tabular-nums" data-next-count-words="">
                    {figure.count === 1 && !figure.partial ? "decision" : "decisions"}
                    {next?.oldestAgeDays != null ? ` · oldest ${daysWaited(next.oldestAgeDays)}` : null}
                  </span>
                </>
              ) : (
                <span className="text-wall-stat font-semibold text-muted-foreground" data-next-count-unread="">
                  {figure.text}
                </span>
              )}
            </div>
          </div>

          {top ? (
            <div className="flex min-w-0 flex-col gap-wall-region border-t border-border/60 pt-wall-region" data-next-top={top.id} data-next-ask={top.ask}>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="m-0 text-wall-strip font-semibold text-foreground [overflow-wrap:anywhere]" data-next-top-title="">
                  <span className="sr-only">{ASK_WORDS[top.ask]}: </span>
                  {top.title}
                </p>
                <p className="m-0 text-wall-detail text-muted-foreground tabular-nums" data-next-top-line="">
                  {decisionLine(top, siteOf(top.asset))}
                </p>
              </div>
              {rest.length > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2" data-next-then="">
                  <span className="text-wall-micro text-muted-foreground">then these</span>
                  <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-x-5 gap-y-2 p-0">
                    {rest.map((decision) => {
                      const card = cards.get(decision.asset);
                      return (
                        <li key={decision.id} className="inline-flex items-center gap-1.5" data-next-then-item={decision.id}>
                          <PropertyFavicon
                            domain={decision.asset}
                            icons={card?.icons}
                            scheme="dark"
                            displayName={siteOf(decision.asset)}
                            className="size-6 font-bold text-foreground"
                          />
                          <span className="sr-only">{`${decision.title}, ${siteOf(decision.asset)}`}</span>
                          {decision.ageDays === null ? null : (
                            <span className="text-wall-detail tabular-nums text-muted-foreground">{formatInt(decision.ageDays)}d</span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ) : null}
            </div>
          ) : calm ? (
            <div className="flex items-center gap-3 border-t border-border/60 pt-wall-region text-wall-body text-muted-foreground" data-next-calm="">
              <CircleCheck className="size-6 shrink-0 text-healthy" aria-hidden />
              Nothing waits on you
            </div>
          ) : null}
        </div>

        <div
          className="flex min-w-0 flex-col gap-wall-region border-t border-border/60 pt-wall-region @xl:border-t-0 @xl:border-s @xl:pt-0 @xl:ps-wall-region-x"
          data-next-agents=""
        >
          <h2 className={eyebrow}>The agents · now</h2>
          {!next ? (
            <span className="text-wall-body text-muted-foreground" data-next-agents-unread="">Tasks unknown</span>
          ) : working.length === 0 ? (
            <span className="text-wall-body text-muted-foreground" data-next-agents-none="">Nothing in progress</span>
          ) : (
            <ol className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
              {working.map((row) => (
                <li
                  key={row.id}
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3"
                  data-next-working={row.id}
                  data-next-urgent={row.urgent ? "" : undefined}
                >
                  {row.urgent ? (
                    <Zap className="size-5 shrink-0 text-urgent" role="img" aria-label="Urgent" />
                  ) : (
                    <span aria-hidden className="mt-2 size-2.5 shrink-0 rounded-full bg-healthy" data-next-dot="" />
                  )}
                  <div className="flex min-w-0 flex-col">
                    <span className="text-wall-body font-medium text-foreground [overflow-wrap:anywhere]">{row.title}</span>
                    <span className="text-wall-micro text-muted-foreground tabular-nums">{workingLine(row, siteOf(row.asset))}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-auto flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-next-done={done === null ? "unknown" : done}>
            {done === null ? (
              <span className="text-wall-body text-muted-foreground">Done this week unknown</span>
            ) : (
              <span className="text-wall-body text-foreground">
                <span className="text-wall-stat font-semibold tabular-nums text-milestone">{formatInt(done)}</span> done this week
              </span>
            )}
            <WorkWeekChip move={done === null ? null : (weeks?.done.move ?? null)} against={LAST_WEEK_BY_TODAY} />
          </div>
        </div>
      </div>
    </section>
  );
}
