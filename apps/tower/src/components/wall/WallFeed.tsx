// The Wall's live feed column (bead ro-trai.9, docs/14-design.md § Feed).
//
// What just happened, newest on top, from GET /api/wall/feed — the Wall's one
// moving part. Every row is a stored event (the Worker unions and folds them);
// this component only draws them and makes an arrival visible across a room:
//
// - ARRIVAL. A row the column has not drawn before slides in at the top (240 ms,
//   none under reduced motion) and keeps a tint of its own tone that fades over
//   two minutes. At most one arrival every 2 s; a burst queues, oldest first, so
//   the newest still lands on top.
// - AGING. A row older than 12 hours drops to muted ink. Times are clock times
//   ("12:24", "7:40p" for yesterday), never "5m ago" churn.
// - FIT. Only whole rows are drawn: a row the column would cut is hidden.
// - FAILURE. A failed poll keeps the last rows, dims the live dot and says
//   "Reconnecting" — never an empty feed that reads as "nothing happened".
//
// Read-only on the TV: nothing here is a control. Colour is tokens only, and the
// glyph carries the kind, so colour is never alone.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from "react";
import {
  ArrowUp,
  CalendarX,
  Check,
  CheckCheck,
  DollarSign,
  FileText,
  GitCommitHorizontal,
  Plug,
  Plus,
  Receipt,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import {
  WALL_FEED_AGED_MS,
  WALL_FEED_ARRIVAL_GAP_MS,
  WALL_FEED_TINT_MS,
  WALL_FEED_TV_ROWS,
  type WallFeedItem,
  type WallFeedKind,
  type WallFeedPayload,
  type WallFeedTone,
} from "@shared/wall-feed";
import { useWallFeed } from "@/hooks/useWallFeed";
import { cn } from "@/lib/utils";

/** One glyph per kind: the shape says what happened, the tone how it went. */
const GLYPH: Record<WallFeedKind, ComponentType<{ className?: string }>> = {
  "task-done": Check,
  "task-filed": Plus,
  alert: TriangleAlert,
  resolved: CheckCheck,
  "source-failed": Unplug,
  "source-back": Plug,
  "job-failed": CalendarX,
  collected: RefreshCw,
  revenue: DollarSign,
  cost: Receipt,
  insights: Sparkles,
  report: FileText,
  deployed: ArrowUp,
  change: GitCommitHorizontal,
  "setting-saved": SlidersHorizontal,
};

/** Tokens only (doc 14): ink for the kind label and glyph, a soft tile behind
 * the glyph, and the arrival tint. */
const TONE: Record<WallFeedTone, { ink: string; tile: string; tint: string }> = {
  healthy: { ink: "text-healthy", tile: "bg-healthy/15", tint: "bg-healthy/10" },
  error: { ink: "text-error", tile: "bg-error/15", tint: "bg-error/10" },
  warn: { ink: "text-warn", tile: "bg-warn/15", tint: "bg-warn/10" },
  info: { ink: "text-info", tile: "bg-info/15", tint: "bg-info/10" },
  revenue: { ink: "text-financial-revenue", tile: "bg-financial-revenue/15", tint: "bg-financial-revenue/10" },
  cost: { ink: "text-financial-cost", tile: "bg-financial-cost/15", tint: "bg-financial-cost/10" },
  neutral: { ink: "text-muted-foreground", tile: "bg-muted-foreground/15", tint: "bg-muted-foreground/10" },
};

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });

/** "12:24" today, "7:40p" yesterday — the TV's own clock and calendar day. */
export function feedClock(atMs: number, nowMs: number): string {
  const text = CLOCK.format(atMs);
  if (DAY.format(atMs) === DAY.format(nowMs)) return text.replace(/[\s\u202f]?[AP]M$/, "");
  return text.replace(/[\s\u202f]?AM$/, "a").replace(/[\s\u202f]?PM$/, "p");
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Which rows are drawn, and which arrived while the column watched.
 *
 * The first payload is drawn whole, with no arrivals: the room was not there to
 * miss it. After that a row the column has not drawn waits in a queue and is
 * released one at a time, at most one every `WALL_FEED_ARRIVAL_GAP_MS`, oldest
 * first. Each release is stamped, and its tint is dropped two minutes later.
 */
function useArrivals(items: readonly WallFeedItem[] | undefined) {
  const [drawn, setDrawn] = useState<ReadonlySet<string> | null>(null);
  const [arrived, setArrived] = useState<ReadonlyMap<string, number>>(new Map());
  const [cooling, setCooling] = useState(false);

  useEffect(() => {
    if (items && drawn === null) setDrawn(new Set(items.map((item) => item.id)));
  }, [items, drawn]);

  const waiting = drawn && items ? items.filter((item) => !drawn.has(item.id)) : [];
  // Newest first on the wire, so the oldest waiting row is the last one.
  const next = waiting.at(-1)?.id ?? null;

  useEffect(() => {
    if (cooling || next === null) return;
    setDrawn((held) => new Set([...(held ?? []), next]));
    setArrived((held) => new Map(held).set(next, Date.now()));
    setCooling(true);
  }, [cooling, next]);

  useEffect(() => {
    if (!cooling) return;
    const timer = window.setTimeout(() => setCooling(false), WALL_FEED_ARRIVAL_GAP_MS);
    return () => window.clearTimeout(timer);
  }, [cooling]);

  useEffect(() => {
    if (arrived.size === 0) return;
    const timers = [...arrived].map(([id, at]) =>
      window.setTimeout(
        () =>
          setArrived((held) => {
            const left = new Map(held);
            left.delete(id);
            return left;
          }),
        Math.max(0, WALL_FEED_TINT_MS - (Date.now() - at)),
      ),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [arrived]);

  const visible = useMemo(
    () => (items ?? []).filter((item) => drawn === null || drawn.has(item.id)),
    [items, drawn],
  );
  return { visible, arrived };
}

/** How many leading rows fit the list whole; the rest are hidden. */
function useWholeRows(list: RefObject<HTMLOListElement | null>, rows: readonly WallFeedItem[]) {
  const [fit, setFit] = useState<number>(Infinity);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const bottom = element.getBoundingClientRect().bottom;
      const children = [...element.children] as HTMLElement[];
      const cut = children.findIndex((child) => child.getBoundingClientRect().bottom > bottom + 0.5);
      setFit(cut === -1 ? Infinity : cut);
    };
    measure();
    // The list AND every row: an arriving row opens its height over 240 ms,
    // pushing the rows below it down after this effect has already measured.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [list, rows]);
  return fit;
}

export interface WallFeedProps {
  /** The last good read; undefined before the first one lands. */
  feed: WallFeedPayload | undefined;
  /** The last poll failed: the rows are the last good ones. */
  failed?: boolean;
  /** The Wall's slow clock, which ages the rows. */
  nowMs: number;
}

/** The feed column itself, from a payload; `WallFeedWidget` polls for it. */
export function WallFeed({ feed, failed = false, nowMs }: WallFeedProps) {
  const { visible, arrived } = useArrivals(feed?.items);
  const listRef = useRef<HTMLOListElement>(null);
  const fit = useWholeRows(listRef, visible);
  const reduced = prefersReducedMotion();

  return (
    <section
      aria-label="Live feed"
      data-wall-feed
      data-feed-state={failed ? "reconnecting" : "live"}
      className="flex h-full min-h-0 min-w-0 flex-col gap-1 overflow-hidden rounded-xl bg-muted/60 px-4 pb-2 pt-4"
    >
      <header className="flex items-center gap-2.5 pb-2">
        <span
          aria-hidden
          data-feed-live-dot
          className={cn(
            "size-3 shrink-0 rounded-full",
            failed ? "bg-muted-foreground" : "bg-healthy ring-4 ring-healthy/30",
          )}
        />
        <span className="text-wall-label font-semibold uppercase tracking-[0.12em] text-foreground">Live</span>
        <span className="ml-auto text-wall-micro text-muted-foreground">
          {failed ? "Reconnecting" : "since last night"}
        </span>
      </header>
      {feed && !failed && feed.items.length === 0 ? (
        <p className="px-2 text-wall-body text-muted-foreground">Nothing new since last night</p>
      ) : null}
      {/* In the TV's layout (`tv:`, the TV, a laptop, a landscape tablet) the
          rows fill whatever height the Wall gives the column and never ask for
          more: out of flow, so a long feed cannot stretch its row. In the one
          column (a portrait tablet, a phone) the feed is the last region and
          as tall as its rows, the TV's twelve at most (beads ro-trai.24,
          ro-trai.29, ro-trai.31). */}
      <div className="relative tv:min-h-80 tv:flex-1">
        {/* Newest first: a feed's order is its meaning, so its rows are not
            grouped by site (doc 14 principle 3b's timeline exemption). */}
        <ol ref={listRef} aria-live="polite" data-order="chronological" className="flex flex-col gap-1 tv:absolute tv:inset-0 tv:overflow-hidden">
          {visible.map((item, index) => {
            const tone = TONE[item.tone];
            const Glyph = GLYPH[item.kind];
            const atMs = Date.parse(item.at);
            const aged = nowMs - atMs > WALL_FEED_AGED_MS;
            const tinted = arrived.has(item.id);
            const cut = index >= fit;
            // In the one column (`stack:`) the feed lists the rows the TV
            // shows and no more (bead ro-trai.31).
            const past = index >= WALL_FEED_TV_ROWS;
            return (
              <li
                key={item.id}
                data-feed-item={item.kind}
                data-feed-arrived={tinted ? "" : undefined}
                data-feed-aged={aged ? "" : undefined}
                data-feed-cut={cut ? "" : undefined}
                data-feed-past-tv={past ? "" : undefined}
                aria-hidden={cut || undefined}
                className={cn("grid shrink-0", tinted && !reduced && "wall-feed-arrive", cut && "invisible", past && "stack:hidden")}
              >
                <div className="relative grid min-h-0 grid-cols-[1.875rem_minmax(0,1fr)_auto] items-start gap-3 overflow-hidden rounded-xl px-2.5 py-2.5">
                  {tinted ? (
                    <span
                      aria-hidden
                      data-feed-tint
                      className={cn("wall-feed-tint pointer-events-none absolute inset-0 rounded-xl", tone.tint)}
                    />
                  ) : null}
                  <span className={cn("relative grid size-[1.875rem] place-items-center rounded-lg", tone.tile, tone.ink)}>
                    <Glyph className="size-4" aria-hidden />
                  </span>
                  <span className="relative flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-wall-list-label font-semibold" data-feed-label>
                      <span className={cn("uppercase tracking-[0.05em]", tone.ink)}>{item.label}</span>
                      {item.site ? <span className="text-muted-foreground"> · {item.site}</span> : null}
                    </span>
                    <span
                      className={cn("line-clamp-2 text-wall-list-line", aged ? "text-muted-foreground" : "text-foreground")}
                      data-feed-text
                    >
                      {item.text}
                    </span>
                  </span>
                  <time
                    dateTime={item.at}
                    className="relative pt-0.5 text-right text-wall-list-meta tabular-nums text-muted-foreground"
                    data-feed-time
                  >
                    {feedClock(atMs, nowMs)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/** The widget the Wall draws: the column, polling its own read. */
export function WallFeedWidget({ nowMs }: { nowMs: number }) {
  const { data, isError } = useWallFeed();
  return <WallFeed feed={data} failed={isError} nowMs={nowMs} />;
}
