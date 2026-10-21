import { CircleHelp, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { TaskCard } from "@noticeos/contract/task-card";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Button } from "@/components/ui/button";
import { pillControlClass } from "@/components/ui/pill";
import { useSiteIcons } from "@/hooks/useSiteIcons";
import { useTasksLive } from "@/hooks/useTasks";
import type { InboxAsk } from "@/lib/task-board-read";
import { taskPath } from "@/lib/task-path";
import { cn } from "@/lib/utils";
import { cardTerms, stakePerMonth } from "./next-read";

/** Rows a list shows before its Show all. */
export const LIST_ROWS = 3;

/** A task's page, carrying where the operator came from, as the board's
 * Open task link does. */
export function useTaskHref(): (task: { id: string; project: string }) => { to: string; state: { returnTo: string } } {
  const { pathname, search } = useLocation();
  const { projectSelection } = useTasksLive();
  return (task) => ({
    to: taskPath(task.id, projectSelection ? task.project : undefined),
    state: { returnTo: `${pathname}${search}` },
  });
}

/** A task's title as the link to its page. */
export function TaskTitleLink({ task, className }: { task: { id: string; title: string; project: string }; className?: string }) {
  const href = useTaskHref()(task);
  return (
    <Link
      to={href.to}
      state={href.state}
      className={cn("min-w-0 text-foreground underline-offset-4 [overflow-wrap:anywhere] hover:underline", pillControlClass, className)}
      data-task-link={task.id}
    >
      {task.title}
    </Link>
  );
}

/** A site's mark beside its name; the name is optional where a row already
 * names the site elsewhere. */
export function SiteMark({ site, name, showName = false, className }: { site: string; name: string; showName?: boolean; className?: string }) {
  const iconsOf = useSiteIcons();
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} data-site-mark={site}>
      <PropertyFavicon domain={site} icons={iconsOf(site)} displayName={name} className="size-4" />
      {showName ? <span className="min-w-0 text-xs font-medium text-foreground [overflow-wrap:anywhere]">{name}</span> : <span className="sr-only">{name}</span>}
    </span>
  );
}

/** What an ask wants, as a glyph: a lock for an approval, a question mark for
 * a question or a choice. */
export function AskGlyph({ ask, className }: { ask: InboxAsk; className?: string }) {
  const Icon = ask === "approve" ? Lock : CircleHelp;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-warn", className)} />;
}

/** The money a card puts at stake, over its odds and the operator's minutes;
 * a row without a card says it is not ranked. */
export function MoneyFigure({ card }: { card: TaskCard | null }) {
  if (card === null) {
    return <span className="text-xs text-muted-foreground" data-money="none">small · not ranked</span>;
  }
  return (
    <span className="flex flex-col items-end gap-0.5 text-end tabular-nums" data-money="">
      <span className="whitespace-nowrap text-sm font-semibold text-financial-revenue">{stakePerMonth(card.valuePerMonth)}</span>
      <span className="whitespace-nowrap text-xs text-muted-foreground">{cardTerms(card)}</span>
    </span>
  );
}

/** Days a fill reaches the end of the track; past it the bar stays full. */
const AGE_FULL_DAYS = 60;
/** From here the wait wears warn. */
const AGE_WARN_DAYS = 30;

/** How long a decision has waited, as a length on a 64 px track and as a
 * figure. Unknown is a word. */
export function AgeBar({ days, className }: { days: number | null; className?: string }) {
  if (days === null) return <span className={cn("text-xs text-muted-foreground", className)}>age unknown</span>;
  const old = days >= AGE_WARN_DAYS;
  return (
    <span className={cn("flex items-center gap-1.5 text-xs tabular-nums", className)} data-age-days={days}>
      <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-viz-track">
        <span className={cn("block h-full rounded-full", old ? "bg-warn" : "bg-muted-foreground/60")} style={{ width: `${(Math.min(days, AGE_FULL_DAYS) / AGE_FULL_DAYS) * 100}%` }} />
      </span>
      <span className={cn("w-9 text-end", old ? "font-semibold text-warn" : "text-muted-foreground")}>
        <span className="sr-only">waiting </span>
        {days >= 1 ? `${days}d` : "today"}
      </span>
    </span>
  );
}

/** The press that shows every row of a list after its first few. */
export function ShowAll({ count, onShow, marks }: { count: number; onShow: () => void; marks?: Record<`data-${string}`, string> }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={onShow} {...marks}>
      Show all {count}
    </Button>
  );
}

/** A list's rows divided by thin lines. */
export function Rows({ children, marks }: { children: ReactNode; marks?: Record<`data-${string}`, string> }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0 @container" {...marks}>
      {children}
    </ul>
  );
}

export const rowClass = "flex flex-col gap-2 border-b border-border/60 py-2.5 last:border-b-0";
