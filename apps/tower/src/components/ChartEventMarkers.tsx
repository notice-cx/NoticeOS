import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatCalendarDate, formatCalendarRange, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ChartEvent {
  date: string;
  label: string;
  detail?: string;
  glyph?: string;
  /** Position in the plot, as a percentage. The original marks stay in place. */
  position: number;
}

interface EventGroup {
  key: string;
  position: number;
  events: ChartEvent[];
}

/** Nearby marks share a hit target, not a date. Every event retains its own
 * date in the disclosure; this keeps dense charts usable at phone widths. */
export function groupChartEvents(events: readonly ChartEvent[], width: number): EventGroup[] {
  const unique = [...new Map(events.map((event) => [
    `${event.date}:${event.label}:${event.detail ?? ""}`, event,
  ])).values()].sort((a, b) => a.position - b.position);
  const groups: EventGroup[] = [];
  const targetX = (event: ChartEvent) => Math.max(22, Math.min(width - 22, event.position / 100 * width));
  for (const event of unique) {
    const previous = groups.at(-1);
    const last = previous?.events.at(-1);
    const overlaps = last && (event.position === last.position ||
      (width > 0 && targetX(event) - targetX(last) < 44));
    if (previous && overlaps) previous.events.push(event);
    else groups.push({ key: `${event.date}:${event.label}`, position: event.position, events: [event] });
  }
  for (const group of groups) {
    group.position = (group.events[0]!.position + group.events.at(-1)!.position) / 2;
    group.events.sort((a, b) => a.date.localeCompare(b.date));
  }
  return groups;
}

function dateLabel(date: string) {
  return date.length === 7 ? formatSeriesDate(date) : formatCalendarDate(date);
}

function groupLabel(group: EventGroup) {
  const first = group.events[0]!;
  const last = group.events.at(-1)!;
  if (group.events.length === 1) return `Event on ${dateLabel(first.date)}: ${first.label}`;
  const span = first.date === last.date ? `on ${dateLabel(first.date)}`
    : `from ${dateLabel(first.date)} to ${dateLabel(last.date)}`;
  return `${group.events.length} events ${span}`;
}

/** Timeline labels are often the opening clause of the full saved note. Show
 * that note once, but retain an independently meaningful title and detail. */
function repeatsDetail(event: ChartEvent) {
  const prefix = event.label.replace(/(?:…|\.\.\.)$/, "").trim();
  return Boolean(event.detail && prefix && event.detail.trimStart().startsWith(prefix));
}

/** Event-specific disclosures shared by desk and specialized Wall charts.
 * Unlike EvidencePopover, these describe chart dates, not health evidence.
 * The layer adds no layout height and never replaces a chart's geometry. */
export function ChartEventMarkers({ events, activeKey, onActiveKeyChange, showGlyph = true, lineTargets = false }: {
  events: readonly ChartEvent[];
  activeKey?: string | null;
  onActiveKeyChange?: (key: string | null) => void;
  showGlyph?: boolean;
  /** Desk annotation lines can be inspected anywhere along their dashed mark. */
  lineTargets?: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ownActiveKey, setOwnActiveKey] = useState<string | null>(null);
  const active = activeKey === undefined ? ownActiveKey : activeKey;
  const groups = groupChartEvents(events, width);
  const change = (key: string | null) => {
    setOwnActiveKey(key);
    onActiveKeyChange?.(key);
  };

  useLayoutEffect(() => {
    const node = layer.current;
    if (!node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (active !== null && !groups.some((group) => group.key === active)) change(null);
  }, [active, groups]);

  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-20" data-chart-events
      onFocus={(event) => event.stopPropagation()}
      onBlur={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}>
      {groups.map((group) => <EventDisclosure key={group.key} group={group}
        open={active === group.key} onOpenChange={(open) => change(open ? group.key : null)}
        showGlyph={showGlyph} lineTargets={lineTargets} plotWidth={width} />)}
    </div>
  );
}

function EventDisclosure({ group, open, onOpenChange, showGlyph, lineTargets, plotWidth }: {
  group: EventGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showGlyph: boolean;
  lineTargets: boolean;
  plotWidth: number;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const id = useId();
  const label = groupLabel(group);
  const clearClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => {
    clearClose();
    pinned.current = false;
    onOpenChange(false);
  };
  const leave = () => {
    if (pinned.current || document.activeElement === trigger.current) return;
    clearClose();
    closeTimer.current = setTimeout(close, 120);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const rect = panel.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
    const top = anchor.bottom + rect.height <= window.innerHeight - 8
      ? anchor.bottom : Math.max(8, anchor.top - rect.height);
    setPosition({ top, left });
  }, [open, group.events.length, plotWidth]);

  useEffect(() => {
    if (!open) {
      pinned.current = false;
      return;
    }
    const outside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      clearClose();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return <>
    {lineTargets ? [...new Set(group.events.map((event) => event.position))].map((position) =>
      <span key={position} aria-hidden data-chart-event-line
        className="pointer-events-auto absolute inset-y-0 w-3 -translate-x-1/2 cursor-help"
        style={{ left: plotWidth > 0 ? Math.max(6, Math.min(plotWidth - 6, position / 100 * plotWidth)) : `${position}%` }}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") { clearClose(); onOpenChange(true); } }}
        onPointerLeave={leave}
        onClick={() => { pinned.current = true; clearClose(); onOpenChange(true); }} />) : null}
    <button ref={trigger} type="button" data-chart-event-dates={group.events.map((event) => event.date).join(" ")}
      className={cn("pointer-events-auto absolute top-0 flex size-11 -translate-x-1/2 items-start justify-center rounded-sm text-xs text-chart-distorted outline-none hover:bg-chart-distorted/10 focus-visible:ring-2 focus-visible:ring-ring", open && "bg-chart-distorted/10")}
      style={{ left: plotWidth > 0 ? Math.max(22, Math.min(plotWidth - 22, group.position / 100 * plotWidth)) : `${group.position}%` }} aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") { clearClose(); onOpenChange(true); } }}
      onPointerLeave={leave}
      onFocus={() => { clearClose(); onOpenChange(true); }}
      onBlur={(event) => { if (!panel.current?.contains(event.relatedTarget)) close(); }}
      onClick={() => { if (pinned.current) close(); else { pinned.current = true; clearClose(); onOpenChange(true); } }} />
    {showGlyph ? <span aria-hidden className="pointer-events-none absolute top-0 inline-flex -translate-x-1/2 items-center gap-0.5 rounded-sm bg-card px-0.5 text-xs font-semibold text-chart-distorted"
      style={{ left: `${group.position}%` }}>
        {group.events[0]!.glyph ?? "▲"}{group.events.length > 1 ? <span className="tabular-nums">{group.events.length}</span> : null}
      </span> : null}
    {open ? createPortal(<div ref={panel} id={id} role="tooltip" aria-label={label}
      className="fixed z-50 grid max-h-[70vh] w-80 max-w-[calc(100vw-1rem)] gap-2 overflow-auto rounded-md border border-border bg-card p-3 text-xs leading-relaxed text-foreground shadow-lg"
      style={position} onPointerEnter={clearClose} onPointerLeave={leave}>
      <span className="font-semibold">{group.events.length === 1 ? dateLabel(group.events[0]!.date)
        : `${group.events.length} events · ${formatCalendarRange(group.events[0]!.date, group.events.at(-1)!.date)}`}</span>
      <ul className="m-0 grid list-none gap-3 p-0">
        {group.events.map((event) => <li key={`${event.date}:${event.label}:${event.detail ?? ""}`} className="grid gap-1">
          {group.events.length > 1 ? <time dateTime={event.date} className="font-medium tabular-nums text-muted-foreground">{dateLabel(event.date)}</time> : null}
          {!repeatsDetail(event) ? <span className="font-medium">{event.label}</span> : null}
          {event.detail ? <span className={repeatsDetail(event) ? "text-foreground" : "text-muted-foreground"}>{event.detail}</span> : null}
        </li>)}
      </ul>
    </div>, document.body) : null}
  </>;
}
