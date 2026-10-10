import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { SeriesPointOrGap } from "@shared/surface";
import { Card, type CardKind } from "@/components/ui/card";
import { Sparkline, type SeriesTone } from "@/components/surface/Sparkline";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

/**
 * One thing that changed since you last looked: one kind, one sentence under
 * twelve words, one shape (a line, a line over its normal band, or a figure)
 * and at most one action. The first card of a brief is drawn larger. The tint
 * is the kind's subject; severity rides the dot.
 */
export type HighlightKind =
  | "alert"
  | "broken"
  | "money"
  | "people"
  | "search"
  | "bet"
  | "shipped"
  | "win"
  | "milestone";

/** The kind's word, set as the eyebrow. */
export const HIGHLIGHT_WORD: Record<HighlightKind, string> = {
  alert: "Alert",
  broken: "Stopped",
  money: "Money",
  people: "People",
  search: "Search",
  bet: "Bet",
  shipped: "Shipped",
  win: "Win",
  milestone: "Milestone",
};

const CARD_KIND: Record<HighlightKind, CardKind> = {
  alert: "alert",
  broken: "alert",
  money: "money",
  people: "neutral",
  search: "neutral",
  bet: "neutral",
  shipped: "neutral",
  win: "win",
  milestone: "win",
};

/** The dot before the eyebrow: severity for an alert, identity for money and
 * people, the milestone emerald for a win, ink for the rest. */
const DOT_CLASS: Record<HighlightKind, string> = {
  alert: "bg-warn",
  broken: "bg-error",
  money: "bg-financial-revenue",
  people: "bg-traffic",
  search: "bg-foreground",
  bet: "bg-foreground",
  shipped: "bg-foreground",
  win: "bg-milestone",
  milestone: "bg-milestone",
};

export interface HighlightSpark {
  data: readonly SeriesPointOrGap[];
  tone: SeriesTone;
  /** The series' normal, drawn behind the line. */
  band?: { low: number; high: number };
  provisionalFrom?: string | null;
  area?: boolean;
  average?: boolean;
  format?: (value: number) => string;
  label: string;
}

export interface HighlightCardProps {
  kind: HighlightKind;
  /** An alert's own severity; the dot takes it. */
  severity?: "error" | "warn";
  /** The site the highlight is about, after the kind word. */
  site?: string | null;
  /** One sentence, under twelve words (the UX gate measures it). */
  title: string;
  /** One line under the shape: when, how much at stake, what is normal. */
  detail?: ReactNode;
  /** A display figure instead of a line — a milestone's count. */
  figure?: string;
  spark?: HighlightSpark;
  /** The one verb: a link to where the evidence is. */
  action?: { label: string; to: string };
  /** Secondary verbs beside it (a snooze), already rendered. */
  actions?: ReactNode;
  /** The first card of a brief. */
  big?: boolean;
  className?: string;
  /** `data-*` marks for the audit and the flow gate's subject reading. */
  marks?: Record<`data-${string}`, string>;
}

export function HighlightCard({
  kind,
  severity,
  site,
  title,
  detail,
  figure,
  spark,
  action,
  actions,
  big = false,
  className,
  marks,
}: HighlightCardProps) {
  const dot = kind === "alert" || kind === "broken" ? (severity === "error" ? "bg-error" : "bg-warn") : DOT_CLASS[kind];
  return (
    <Card
      kind={CARD_KIND[kind]}
      data-highlight={kind}
      data-highlight-big={big ? "" : undefined}
      className={cn("flex min-w-0 flex-col gap-2.5 p-4", big && "gap-3 lg:col-span-2", className)}
      {...marks}
    >
      <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <i aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} />
        <span className="truncate">
          {HIGHLIGHT_WORD[kind]}
          {site ? ` · ${site}` : null}
        </span>
      </span>
      <span className={cn("text-[15px] font-semibold leading-[1.3] tracking-[-0.01em] text-foreground", big && "text-[20px] leading-[1.25]")}>
        {title}
      </span>
      {figure ? (
        <span className="text-[44px] font-bold leading-none tracking-[-0.045em] tabular-nums text-foreground max-sm:text-[32px]" data-highlight-figure>
          {figure}
        </span>
      ) : spark ? (
        <Sparkline
          data={spark.data}
          size="wide"
          tone={spark.tone}
          band={spark.band}
          provisionalFrom={spark.provisionalFrom ?? null}
          area={spark.area ?? false}
          average={spark.average ?? false}
          format={spark.format}
          ariaLabel={spark.label}
          data-spark="highlight"
          readout
          className={big ? "[&_svg]:h-16" : undefined}
        />
      ) : null}
      {detail ? <span className="text-[13px] leading-[1.4] text-muted-foreground">{detail}</span> : null}
      {action || actions ? (
        <span className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {action ? (
            <Link
              to={action.to}
              className={cn(
                pillControlClass,
                "inline-flex min-h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary-hover max-sm:min-h-11",
              )}
              data-highlight-action
            >
              {action.label}
            </Link>
          ) : null}
          {actions}
        </span>
      ) : null}
    </Card>
  );
}
