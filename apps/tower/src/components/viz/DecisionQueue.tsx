import { CircleHelp, Triangle } from "lucide-react";
import { Children, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// A queue drawn as a queue: how many are waiting, how old the wait is (the
// age spread as one bar, oldest first in the eye), then the rows, each with its
// age as a length so the forgotten ones stand out without reading. The verb on
// a row stays quiet until the row is pointed at or focused, so a list of
// identical buttons never outshouts the work it describes.

export interface QueueItem {
  id: string;
  title: string;
  /** The project or site it belongs to. */
  project: string;
  kind: "approval" | "question";
  /** Days waiting, or null when the store has no timestamp for it. */
  ageDays: number | null;
  to?: string;
  /** Where the opened page's back link returns to. */
  returnTo?: string;
  /** The row's verbs (Approve, Answer, Dismiss), already wired. */
  actions?: ReactNode;
  /** Anything under the row: an answer box opened by a verb. */
  below?: ReactNode;
}

export interface AgeBucket {
  key: "fresh" | "week" | "month" | "old";
  label: string;
  count: number;
}

const BUCKETS: readonly { key: AgeBucket["key"]; label: string; upTo: number; fill: string }[] = [
  { key: "fresh", label: "under 7d", upTo: 7, fill: "bg-muted-foreground/35" },
  { key: "week", label: "7–30d", upTo: 30, fill: "bg-warn/45" },
  { key: "month", label: "30–60d", upTo: 60, fill: "bg-warn/75" },
  { key: "old", label: "over 60d", upTo: Number.POSITIVE_INFINITY, fill: "bg-warn" },
];

/** The queue's age spread over the items whose age is known. */
export function ageBuckets(items: readonly Pick<QueueItem, "ageDays">[]): AgeBucket[] {
  return BUCKETS.map((bucket, index) => {
    const from = index === 0 ? 0 : BUCKETS[index - 1]!.upTo;
    return {
      key: bucket.key,
      label: bucket.label,
      count: items.filter((item) => item.ageDays !== null && item.ageDays >= from && item.ageDays < bucket.upTo).length,
    };
  });
}

/** A wait in its own unit: hours under a day, whole days after. */
export function ageLabel(days: number): string {
  return days < 1 ? `${Math.max(1, Math.round(days * 24))}h` : `${formatInt(Math.floor(days))}d`;
}

/** Age drawn on a log scale to 90 days, so a 2-day wait and a 67-day wait are
 * both visible and plainly different. */
export function ageLength(days: number): number {
  return Math.min(1, Math.log1p(Math.max(0, days)) / Math.log1p(90));
}

export interface DecisionQueueProps {
  items: QueueItem[];
  /** The whole queue's size when only part of it was read into `items`. */
  total?: number | null;
  /** What qualifies that count: "partial read", "outdated". */
  totalNote?: string;
  /** Rows shown before "Show all". */
  limit?: number;
  title?: string;
  /** "All tasks →". */
  action?: { label: string; to: string };
  /** The queue could not be read, or is empty: one line in place of the rows. */
  empty?: string;
  /** The rows, when each needs its own state (wired verbs): `QueueRow`s in
   * `items` order. Without them the queue draws `items` itself. */
  children?: ReactNode;
  className?: string;
}

export function DecisionQueue({ items, total = null, totalNote, limit = 4, title = "Decide", action, empty = "Nothing to decide.", children, className }: DecisionQueueProps) {
  const [open, setOpen] = useState(false);
  const count = total ?? items.length;
  const buckets = ageBuckets(items);
  const known = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const oldest = items.reduce<number | null>((max, item) => (item.ageDays === null ? max : Math.max(max ?? 0, item.ageDays)), null);
  const rows = children === undefined ? items.map((item, index) => <QueueRow key={item.id} item={item} index={index} />) : Children.toArray(children);
  const shown = open ? rows : rows.slice(0, limit);

  return (
    <section aria-label={title} data-decision-queue="" className={cn("@container flex min-w-0 flex-col rounded-xl bg-card ring-1 ring-border/70", className)}>
      <header className="flex flex-col gap-3 px-5 pb-3 pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className={cn("m-0", eyebrowClass)}>{title}</h2>
          {action ? (
            <Link to={action.to} className="whitespace-nowrap text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              {action.label}
            </Link>
          ) : null}
        </div>
        {count > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-figure tabular-nums text-foreground">{formatInt(count)}</span>
            <span className="text-sm text-muted-foreground">
              waiting on you{oldest !== null ? <> · oldest <b className="font-semibold text-warn">{ageLabel(oldest)}</b></> : null}
              {totalNote ? ` · ${totalNote}` : null}
            </span>
          </div>
        ) : null}
        {known > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div role="img" aria-label={`Waiting: ${buckets.map((bucket) => `${bucket.count} ${bucket.label}`).join(", ")}`} className="flex h-2 gap-0.5 overflow-hidden rounded-full">
              {buckets.map((bucket, index) =>
                bucket.count > 0 ? (
                  <span
                    key={bucket.key}
                    data-age-bucket={bucket.key}
                    className={cn("viz-grow-x h-full min-w-1 first:rounded-s-full last:rounded-e-full", BUCKETS[index]!.fill)}
                    style={{ flexGrow: bucket.count, ["--viz-i" as string]: index }}
                  />
                ) : null,
              )}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-micro tabular-nums text-muted-foreground" aria-hidden>
              {buckets.map((bucket, index) =>
                bucket.count > 0 ? (
                  <span key={bucket.key} className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span className={cn("size-2 rounded-full", BUCKETS[index]!.fill)} />
                    {formatInt(bucket.count)} {bucket.label}
                  </span>
                ) : null,
              )}
            </div>
          </div>
        ) : null}
      </header>
      {items.length === 0 ? (
        <p className="m-0 border-t border-border/60 px-5 py-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col border-t border-border/60 p-0">
          {shown}
        </ul>
      )}
      {rows.length > limit ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="border-t border-border/60 px-5 py-2.5 text-start text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? "Show fewer" : `Show ${formatInt(rows.length - limit)} more`}
        </button>
      ) : null}
    </section>
  );
}

/** One waiting item: its kind, title, project and age as a length, and its
 * verbs, quiet until the row is pointed at or focused. */
export function QueueRow({ item, index }: { item: QueueItem; index: number }) {
  const Glyph = item.kind === "approval" ? Triangle : CircleHelp;
  const age = item.ageDays;
  const title = item.to ? (
    <Link to={item.to} state={item.returnTo ? { returnTo: item.returnTo } : undefined} className="line-clamp-2 font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" title={item.title}>
      {item.title}
    </Link>
  ) : (
    <span className="line-clamp-2 font-medium text-foreground" title={item.title}>{item.title}</span>
  );
  return (
    <li
      data-queue-item={item.id}
      className="viz-arrive group grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b border-border/40 px-5 py-2.5 last:border-b-0 hover:bg-muted/30 focus-within:bg-muted/30 @lg:grid-cols-[auto_minmax(0,1fr)_auto]"
      style={{ ["--viz-i" as string]: index }}
    >
      <Glyph aria-label={item.kind === "approval" ? "Approval" : "Question"} className="size-4 shrink-0 text-warn" />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 text-sm">{title}</span>
        <span className="flex min-w-0 items-center gap-2 text-micro text-muted-foreground">
          <span className="truncate">{item.project}</span>
          {age !== null ? (
            <span className="ms-auto flex shrink-0 items-center gap-1.5 tabular-nums" aria-label={`waiting ${ageLabel(age)}`}>
              <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-viz-track">
                <span className={cn("block h-full rounded-full", age >= 30 ? "bg-warn" : "bg-muted-foreground/60")} style={{ width: `${ageLength(age) * 100}%` }} />
              </span>
              <span className={cn("w-8 text-end", age >= 30 && "font-semibold text-warn")}>{ageLabel(age)}</span>
            </span>
          ) : (
            <span className="ms-auto shrink-0">age unknown</span>
          )}
        </span>
      </span>
      {item.actions ? (
        // Beside the row when the panel has room, under its title when it does not.
        <span className="col-start-2 flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100 @lg:col-start-auto">{item.actions}</span>
      ) : null}
      {item.below ? <div className="col-span-full">{item.below}</div> : null}
    </li>
  );
}
