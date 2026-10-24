// The Wall's live feed column: what just happened, newest on top, from
// GET /api/wall/feed — the Wall's one
// moving part. Every row is a stored event (the Worker unions and folds them);
// this component only draws them and makes an arrival visible across a room:
//
// - Arrival. A row the column has not drawn before slides in at the top (240 ms,
//   none under reduced motion) and keeps a tint of its own tone that fades over
//   two minutes. At most one arrival every 2 s; a burst queues, oldest first, so
//   the newest still lands on top.
// - Aging. A row older than 12 hours drops to muted ink. Times are clock times
//   ("12:24", "7:40p" for yesterday), never "5m ago" churn.
// - Fit. Only whole rows are drawn: a row the column would cut is hidden.
// - Failure. A failed poll keeps the last rows, dims the live dot and says
//   "Reconnecting" — never an empty feed that reads as "nothing happened".
//
// A task line opens its task page; no other line is a control, and nothing on
// a TV is pressed. Colour is tokens only, and the
// glyph carries the kind, so colour is never alone. A line about an
// asset draws its icon with an event-kind badge; the header carries a known
// agent's small mark and model. Assetless events keep their agent or kind icon.

import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { SiteIcons } from "@noticeos/contract/site-icons";
import type { AssetCard } from "@shared/wall";
import {
  ArrowUp,
  CalendarX,
  Check,
  CheckCheck,
  CircleDot,
  CircleSlash,
  DollarSign,
  FileText,
  GitCommitHorizontal,
  ListChecks,
  Plug,
  Plus,
  Receipt,
  RefreshCw,
  Radio,
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
import { AgentMark } from "@/components/AgentMark";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { useWallFeed } from "@/hooks/useWallFeed";
import { useWholeRows } from "@/hooks/useWholeRows";
import { agentMaker, evidenceParts } from "@/lib/agent-work";
import { taskPath } from "@/lib/task-path";
import { cn } from "@/lib/utils";
import { MetricTile } from "@/components/wall/MetricWidgets";
import "./WallFeed.css";

/** One glyph per kind: the shape says what happened, the tone how it went. */
const GLYPH: Record<WallFeedKind, ComponentType<{ className?: string }>> = {
  "task-done": Check,
  "task-closed": CircleSlash,
  "task-claimed": CircleDot,
  "task-filed": Plus,
  "task-chosen": ListChecks,
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

/** What the worker on a task line did: "claude filed …", or "Dana chose (b) Keep both on …". */
const VERB: Partial<Record<WallFeedKind, string>> = {
  "task-filed": "filed",
  "task-claimed": "claimed",
  "task-done": "closed",
  "task-closed": "closed",
  "task-chosen": "chose",
};

/** Tokens only: ink for the kind label and glyph, a soft tile behind
 * the glyph, a solid badge on an agent's mark, and the arrival tint. */
const TONE: Record<WallFeedTone, { ink: string; tile: string; badge: string; tint: string }> = {
  healthy: { ink: "text-healthy", tile: "bg-healthy/15", badge: "bg-healthy", tint: "bg-healthy/10" },
  error: { ink: "text-error", tile: "bg-error/15", badge: "bg-error", tint: "bg-error/10" },
  warn: { ink: "text-warn", tile: "bg-warn/15", badge: "bg-warn", tint: "bg-warn/10" },
  info: { ink: "text-info", tile: "bg-info/15", badge: "bg-info", tint: "bg-info/10" },
  revenue: { ink: "text-financial-revenue", tile: "bg-financial-revenue/15", badge: "bg-financial-revenue", tint: "bg-financial-revenue/10" },
  cost: { ink: "text-financial-cost", tile: "bg-financial-cost/15", badge: "bg-financial-cost", tint: "bg-financial-cost/10" },
  neutral: { ink: "text-muted-foreground", tile: "bg-muted-foreground/15", badge: "bg-muted-foreground", tint: "bg-muted-foreground/10" },
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

export interface WallFeedProps {
  /** The last good read; undefined before the first one lands. */
  feed: WallFeedPayload | undefined;
  /** The last poll failed: the rows are the last good ones. */
  failed?: boolean;
  /** The Wall's slow clock, which ages the rows. */
  nowMs: number;
  /** Each site's icons from its card, by site id; a site absent here draws
   * its `/favicon.ico`. */
  icons?: ReadonlyMap<string, SiteIcons | null | undefined>;
}

/** The feed column itself, from a payload; `WallFeedWidget` polls for it. */
export function WallFeed({ feed, failed = false, nowMs, icons }: WallFeedProps) {
  const { visible, arrived } = useArrivals(feed?.items);
  const listRef = useRef<HTMLOListElement>(null);
  const fit = useWholeRows(listRef, visible);
  const reduced = prefersReducedMotion();

  return (
    <div
      data-wall-feed
      data-feed-state={failed ? "reconnecting" : "live"}
      className="h-full min-h-0 min-w-0"
    >
      <MetricTile title="Live feed" icon={Radio} className="wall-feed-metric" context={<span className="inline-flex items-center gap-2">
        <span
          aria-hidden
          data-feed-live-dot
          className={cn(
            "size-2 shrink-0 rounded-full",
            failed ? "bg-muted-foreground" : "bg-healthy",
          )}
        />
          {failed ? "Reconnecting" : "since last night"}
      </span>}>
      {feed && !failed && feed.items.length === 0 ? (
        <p className="wall-feed-empty text-muted-foreground">Nothing new since last night</p>
      ) : null}
      {/* In the TV's layout (`tv:`, the TV, a laptop, a landscape tablet) the
          rows fill whatever height the Wall gives the column and never ask for
          more: out of flow, so a long feed cannot stretch its row. In the one
          column (a portrait tablet, a phone) the feed is the last region and
          as tall as its rows, the TV's twelve at most. */}
      <div className="relative tv:min-h-0 tv:flex-1">
        {/* Newest first: a feed's order is its meaning, so its rows are not
            grouped by site. */}
        <ol ref={listRef} aria-live="polite" data-order="chronological" className="flex flex-col gap-1 tv:absolute tv:inset-0 tv:overflow-hidden">
          {visible.map((item, index) => {
            const tone = TONE[item.tone];
            const Glyph = GLYPH[item.kind];
            const maker = item.who ? agentMaker(item.who, [item.model ?? null]) : null;
            const atMs = Date.parse(item.at);
            const aged = nowMs - atMs > WALL_FEED_AGED_MS;
            const tinted = arrived.has(item.id);
            const cut = index >= fit;
            // In the one column (`stack:`) the feed lists the rows the TV
            // shows and no more.
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
                <FeedRow task={item.task}>
                  {tinted ? (
                    <span
                      aria-hidden
                      data-feed-tint
                      className={cn("wall-feed-tint pointer-events-none absolute inset-0 rounded-xl", tone.tint)}
                    />
                  ) : null}
                  {item.asset ? (
                    <span className="wall-feed-glyph relative" role="img" aria-label={item.site ?? item.asset} title={item.site ?? item.asset} data-feed-asset={item.asset}>
                      <PropertyFavicon domain={item.asset} icons={icons?.get(item.asset)} scheme="dark" displayName={item.site ?? item.asset} className="wall-feed-glyph" />
                      <span data-feed-badge className={cn("wall-feed-agent-badge absolute -bottom-1 -right-1 grid place-items-center rounded-full text-background ring-2 ring-background", tone.badge)}><Glyph className="size-2.5" aria-hidden /></span>
                    </span>
                  ) : maker && item.who ? (
                    <span className="wall-feed-glyph relative" data-feed-agent={maker}>
                      <AgentMark name={item.who} models={[item.model ?? null]} size="feed" className="wall-feed-agent-mark" />
                      <span
                        data-feed-badge
                        className={cn("wall-feed-agent-badge absolute -bottom-1 -right-1 grid place-items-center rounded-full text-background ring-2 ring-background", tone.badge)}
                      >
                        <Glyph className="size-2.5" aria-hidden />
                      </span>
                    </span>
                  ) : (
                    <span className={cn("wall-feed-glyph relative grid place-items-center rounded-lg", tone.tile, tone.ink)}>
                      <Glyph className="size-4" aria-hidden />
                    </span>
                  )}
                  <span className="relative flex min-w-0 flex-col gap-0.5">
                    <span className="wall-feed-label truncate font-semibold" data-feed-label>
                      <span className={cn("uppercase tracking-[0.05em]", tone.ink)}>{item.label}</span>
                      {maker && item.who ? (
                        <span className="text-muted-foreground" data-feed-model>
                          {" · "}<span data-feed-agent={maker}><AgentMark name={item.who} models={[item.model ?? null]} size="small" className="wall-feed-header-agent" /></span>{" "}{item.model ?? item.who}
                        </span>
                      ) : item.model ? (
                        <span className="text-muted-foreground" data-feed-model>{" · "}{item.model}</span>
                      ) : !item.asset && item.site ? (
                        <span className="text-muted-foreground">{" · "}{item.site}</span>
                      ) : null}
                    </span>
                    <span
                      className={cn("wall-feed-text line-clamp-3", aged ? "text-muted-foreground" : "text-foreground")}
                      data-feed-text
                    >
                      {item.who ? (
                        <>
                          <span className="font-semibold" data-feed-who>{item.who}</span>
                          {" "}<span className={cn(item.kind === "task-done" ? "text-healthy" : "text-muted-foreground")} data-feed-verb>{VERB[item.kind]}</span>{" "}
                          {item.choice ? (
                            <>
                              <span className="font-semibold" data-feed-choice>{item.choice}</span>
                              {" "}<span className="text-muted-foreground">on</span>{" "}
                            </>
                          ) : null}
                        </>
                      ) : null}
                      {item.text}
                    </span>
                    {item.evidence ? <FeedEvidence evidence={item.evidence} /> : null}
                  </span>
                  <time
                    dateTime={item.at}
                    className="wall-feed-meta relative pt-0.5 text-right tabular-nums text-muted-foreground"
                    data-feed-time
                  >
                    {feedClock(atMs, nowMs)}
                  </time>
                </FeedRow>
              </li>
            );
          })}
        </ol>
      </div>
      </MetricTile>
    </div>
  );
}

const ROW = "wall-feed-row relative grid min-h-0 items-start overflow-hidden rounded-xl";

/** A task line is a link to its task page; every other line is text. */
function FeedRow({ task, children }: { task?: string; children: ReactNode }) {
  return task ? (
    <Link to={taskPath(task)} data-feed-task={task}
      className={cn(ROW, "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
      {children}
    </Link>
  ) : (
    <div className={ROW}>{children}</div>
  );
}

/** A close's evidence pointers, kept separately from its task title. */
function FeedEvidence({ evidence }: { evidence: string }) {
  const pointers = evidence ? evidenceParts(evidence).filter((part) => part.kind !== "text") : [];
  if (!pointers.length) return null;
  return (
    <span className="wall-feed-meta flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-muted-foreground" data-feed-evidence>
      {pointers.map((part, index) => (
        <span key={index} className={cn("rounded-md bg-background/60 px-1.5 py-px", part.kind === "commit" && "font-mono")}>{part.text}</span>
      ))}
    </span>
  );
}

/** The widget the Wall draws: all stored activity, polling its own read,
 * each site drawn with the icons on its card. */
export function WallFeedWidget({
  nowMs,
  assets,
}: {
  nowMs: number;
  assets?: readonly Pick<AssetCard, "id" | "icons">[];
}) {
  const { data, isError } = useWallFeed();
  const icons = useMemo(() => new Map(assets?.map((asset) => [asset.id, asset.icons])), [assets]);
  return <WallFeed feed={data} failed={isError} nowMs={nowMs} icons={icons} />;
}
