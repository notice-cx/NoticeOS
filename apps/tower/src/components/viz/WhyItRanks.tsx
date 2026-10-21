import { Clock, Coins, Crosshair, Hourglass, OctagonX } from "lucide-react";
import type { ReactNode } from "react";
import type { TaskCard, TaskCardScore } from "@noticeos/contract/task-card";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface WhyItRanksProps {
  card: TaskCard;
  /** Policy v1.0 over the card, when the rate it needs is known. */
  score: TaskCardScore | null;
  /** This task's place in the list it was ranked in. */
  rank?: { position: number; of: number } | null;
  /** `md` leads a card or a page section; `sm` sits in a row. */
  size?: "sm" | "md";
  className?: string;
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A calendar date as the day it names, in no time zone: `2026-11-11` is Nov 11 everywhere. */
export function killDateLabel(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? MONTH_DAY.format(parsed) : date;
}

/** Days under two weeks read as days; longer horizons as whole weeks. */
export function signalLabel(days: number): { figure: string; unit: string } {
  if (days < 14) return { figure: formatInt(days), unit: days === 1 ? "day" : "days" };
  const weeks = Math.round(days / 7);
  return { figure: formatInt(weeks), unit: weeks === 1 ? "week" : "weeks" };
}

/** The money figure: a dollar amount a month, signed, with its estimate mark. */
export function stakeLabel(valuePerMonth: number): string {
  const sign = valuePerMonth < 0 ? "−" : "";
  return `≈ ${sign}${formatUsd(Math.abs(valuePerMonth))}`;
}

/**
 * Why a task is worth doing, as its card's figures in a row: money at stake,
 * how likely it is to pay off, the operator's minutes, when the ledger will
 * show it, and the date it is given up on. One figure per fact, each with its
 * unit a step lighter, so the row is read left to right as the card's sentence.
 */
export function WhyItRanks({ card, score, rank = null, size = "md", className }: WhyItRanksProps) {
  const figureClass = size === "md" ? "text-figure-sm" : "text-base font-semibold";
  const filled = Math.round(card.likelihood * 10);
  const signal = signalLabel(card.daysToSignal);
  return (
    <dl
      data-why-it-ranks=""
      className={cn(
        "m-0 grid grid-cols-[repeat(auto-fit,minmax(min(132px,100%),1fr))] gap-x-6 gap-y-3 tabular-nums",
        className,
      )}
    >
      <Figure icon={<Coins aria-hidden className="size-3.5" />} label="At stake">
        <span className={cn(figureClass, "text-financial-revenue")}>{stakeLabel(card.valuePerMonth)}</span>
        <Unit>/mo · est.</Unit>
      </Figure>
      <Figure icon={<Crosshair aria-hidden className="size-3.5" />} label="Likely to pay off">
        <span className="flex items-center gap-2.5">
          <span className={figureClass}>{Math.round(card.likelihood * 100)}%</span>
          <span aria-hidden className="flex gap-[3px]">
            {Array.from({ length: 10 }, (_, index) => (
              <span
                key={index}
                className={cn("h-3.5 w-[6px] rounded-[2px]", index < filled ? "bg-foreground/80" : "bg-border")}
              />
            ))}
          </span>
        </span>
      </Figure>
      <Figure icon={<Clock aria-hidden className="size-3.5" />} label="Your time">
        {card.reviewMinutes === 0 ? (
          <span className={figureClass}>none</span>
        ) : (
          <>
            <span className={figureClass}>{formatInt(card.reviewMinutes)}</span>
            <Unit>min{card.buildMinutes ? ` · ${formatInt(Math.round(card.buildMinutes / 60))} h of build` : ""}</Unit>
          </>
        )}
      </Figure>
      <Figure icon={<Hourglass aria-hidden className="size-3.5" />} label="Signal in">
        <span className={figureClass}>{signal.figure}</span>
        <Unit>{signal.unit}</Unit>
      </Figure>
      {card.kill ? (
        <Figure icon={<OctagonX aria-hidden className="size-3.5" />} label="Kill date">
          <span className={figureClass}>{killDateLabel(card.kill.date)}</span>
        </Figure>
      ) : null}
      {rank && score ? (
        <Figure label="Rank">
          <span className={figureClass}>{formatInt(rank.position)}</span>
          <Unit>of {formatInt(rank.of)} · policy {score.policy}</Unit>
        </Figure>
      ) : null}
    </dl>
  );
}

function Figure({ icon, label, children }: { icon?: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="m-0 flex items-baseline gap-1.5">{children}</dd>
    </div>
  );
}

function Unit({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}
