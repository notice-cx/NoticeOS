// The Wall, drawn from a `WallLayout` document. The TV and the editor's
// preview draw the same canvas; the editor's chrome arrives through the
// `editing` slot and is never imported by `/wall`. Row tracks are an inline
// style, because a class computed at runtime is one Tailwind never generated.
// The strip's clock ticks on its own second so the rest of the Wall is not
// redrawn sixty times a minute.

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import type { CalendarUpcoming, Ga4RealtimePayload } from "@noticeos/contract";
import { NO_READS, type ConnectionReads } from "@shared/connection-status";
import type { WallPayload } from "@shared/wall";
import {
  isWallColumn,
  type WallColumn,
  type WallColumnRow,
  type WallLayout,
  type WallRow,
  type WallSlot,
  type WallWidget,
  wallWidgetSpec,
} from "@shared/wall-layout";
// Read-only imports only: `/wall` downloads everything this file imports, and
// the route-split journey fails if editing or task code reaches the TV.
import { NeedsYou } from "@/components/wall/NeedsYou";
import { RevenueHero } from "@/components/wall/RevenueHero";
import { SiteRows } from "@/components/wall/SiteRows";
import { WallFeedWidget } from "@/components/wall/WallFeed";
import { WallStrip, type WallStripProps } from "@/components/wall/WallStrip";
import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/utils";
import { wallIssues } from "@/lib/wall-issues";
import type { CalendarReadState } from "@/lib/meetings";
import {
  filterWallAssets,
  filterWallAttention,
  wallWidgetHasContent,
} from "@/lib/wall-widgets";

/** What the `editing` slot is handed for one drawn widget. */
export interface WallWidgetSlot {
  widget: WallWidget;
  row: WallRow | WallColumnRow;
  /** Index of the row among its siblings: `layout.rows`, or its column's rows. */
  rowIndex: number;
  /** The column the widget is stacked in; null for a widget in a top-level row. */
  column: WallColumn | null;
  /** The layout's own index in `row.widgets`, not the index among visible
   * widgets, so a drop lands where the operator aimed when a neighbour hides. */
  index: number;
  /** The widget as the TV would draw it. */
  node: ReactNode;
}

export interface WallCanvasProps {
  layout: WallLayout;
  /** The whole polled payload; every widget takes its own slice. */
  data: WallPayload;
  /** The Wall's slow clock — everything but the strip's time ages off it. */
  nowMs: number;
  /** The surface's own upcoming-meetings poll. */
  meetings?: CalendarUpcoming | null;
  calendarState?: CalendarReadState;
  /** The independent 30-second GA4 read; failure never blanks a card. */
  ga4Realtime?: Ga4RealtimePayload;
  ga4RealtimeError?: boolean;
  /** Showing a held payload after a failed poll: the strip says so, with its age. */
  lastGood?: boolean;
  /** The reads every source mark is read from, the surface's own polls. */
  connections?: ConnectionReads;
  /** The editor's slot. Whatever it returns replaces the widget in its own
   * grid track. The TV passes nothing. */
  editing?: (slot: WallWidgetSlot) => ReactNode;
}

/** The one-second tick the strip's time, meeting and countdown share. */
const WallSecondsContext = createContext<number | null>(null);

/** `children` arrives as a prop, so only the context's readers repaint. */
function WallSeconds({ children }: { children: ReactNode }) {
  const nowMs = useNow(1_000);
  return (
    <WallSecondsContext.Provider value={nowMs}>{children}</WallSecondsContext.Provider>
  );
}

/** The shared tick, or this render's own clock when the canvas is not above. */
function useWallSeconds(): number {
  const shared = useContext(WallSecondsContext);
  return shared ?? Date.now();
}

/** The strip's clock, meeting and countdown age off the same shared second. */
function WallStripNow(props: Omit<WallStripProps, "nowMs">) {
  return <WallStrip {...props} nowMs={useWallSeconds()} />;
}

/**
 * The grid template one row's visible widgets produce: the library's floor
 * and the layout's weight, in widget order. TV tracks only; a portrait screen
 * is one column (`stacked`). A widget with a `maxWidthRem` keeps its share by
 * weight until that share reaches its cap, written as a floor on the uncapped
 * tracks so a wider screen widens them and never the capped widget.
 */
export function wallRowTracks(slots: WallSlot[]): string {
  const capOf = (slot: WallSlot) => (isWallColumn(slot) ? null : wallWidgetSpec(slot.type).maxWidthRem);
  const capped = slots.map(capOf).filter((cap): cap is number => cap !== null);
  const uncappedWeight = slots.filter((slot) => capOf(slot) === null).reduce((sum, slot) => sum + slot.width, 0);
  const gaps = slots.length - 1;
  return slots
    .map((slot) => {
      const floor = `min(${slotFloorRem(slot)}rem, 100%)`;
      if (capped.length === 0 || capOf(slot) !== null) return `minmax(${floor}, ${slot.width}fr)`;
      const rest = `calc((100% - ${gaps} * var(--wall-region-gap-x) - ${capped.reduce((a, b) => a + b, 0)}rem) * ${slot.width} / ${uncappedWeight})`;
      return `minmax(max(${floor}, ${rest}), ${slot.width}fr)`;
    })
    .join(" ");
}

/** A widget's floor is the library's; a column's is its widest row's floors
 * added up, so a column never squeezes the widgets it stacks below theirs. */
function slotFloorRem(slot: WallSlot): number {
  if (!isWallColumn(slot)) return wallWidgetSpec(slot.type).minWidthRem;
  return Math.max(
    0,
    ...slot.rows.map((row) => row.widgets.reduce((sum, w) => sum + wallWidgetSpec(w.type).minWidthRem, 0)),
  );
}

export function WallCanvas({
  layout,
  data,
  nowMs,
  meetings,
  calendarState,
  ga4Realtime,
  ga4RealtimeError = false,
  lastGood = false,
  connections,
  editing,
}: WallCanvasProps) {
  function draw(widget: WallWidget): ReactNode {
    switch (widget.type) {
      case "strip":
        return (
          <WallStripNow
            system={data.system}
            assets={data.assets}
            connections={connections}
            countdown={data.dashboard.countdown}
            meetings={meetings}
            calendarState={calendarState}
            heldSince={lastGood ? data.generatedAt : null}
          />
        );
      case "revenue":
        return <RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={nowMs} />;
      case "needs":
        return (
          <NeedsYou
            system={data.system}
            issues={wallIssues({
              assets: filterWallAssets(data.assets, widget.settings),
              attention: filterWallAttention(data.attention, widget.settings),
              connections: connections ?? NO_READS,
              calendarState,
              nowMs,
            })}
            operator={data.operator}
            nowMs={nowMs}
          />
        );
      case "sites": {
        const assets = filterWallAssets(data.assets, widget.settings);
        return (
          <SiteRows
            assets={assets}
            pulseMetrics={widget.settings?.pulseMetrics}
            issues={wallIssues({
              assets,
              attention: filterWallAttention(data.attention, widget.settings),
              connections: connections ?? NO_READS,
              nowMs,
            })}
            ga4Realtime={ga4Realtime}
            ga4RealtimeError={ga4RealtimeError}
            nowMs={nowMs}
          />
        );
      }
      case "feed":
        // Its own read: only a Wall that places the feed asks for it.
        return <WallFeedWidget nowMs={nowMs} />;
    }
  }

  // Hiding is decided bottom-up, so an empty column never keeps a track.
  const shows = (slot: WallSlot): boolean =>
    isWallColumn(slot)
      ? slot.rows.some((inner) => inner.widgets.some(shows))
      : wallWidgetHasContent(slot.type);

  function drawRow(row: WallRow | WallColumnRow, rowIndex: number, column: WallColumn | null): ReactNode {
    const drawn = row.widgets
      .map((slot: WallSlot, index) => ({ slot, index }))
      .filter(({ slot }) => shows(slot));
    if (drawn.length === 0) return null;
    return (
      <div
        key={row.id}
        data-wall-row={row.id}
        data-wall-row-height={row.height}
        // A row is a box only at the TV's width; below it, it dissolves into
        // the canvas's one column (`stacked` below).
        className={cn(
          "contents tv:grid tv:grid-cols-(--wall-row-tracks) tv:gap-x-wall-region-x tv:gap-y-wall-region",
          row.height === "fill" ? "tv:min-h-0 tv:flex-1" : null,
        )}
        style={{ "--wall-row-tracks": wallRowTracks(drawn.map((d) => d.slot)) } as CSSProperties}
      >
        {drawn.map(({ slot, index }) => {
          if (isWallColumn(slot)) {
            // A column is one track of its row holding rows of its own; its
            // `fill` row takes the height its other rows leave.
            return (
              <div
                key={slot.id}
                data-wall-column={slot.id}
                className={cn(
                  "contents tv:flex tv:min-h-0 tv:min-w-0 tv:flex-col tv:gap-wall-region",
                  // The editor outlines the column; the TV draws no chrome.
                  // Four pixels, because the preview draws the TV at about half size.
                  editing ? "outline-dashed outline-4 outline-offset-2 outline-muted-foreground/50" : null,
                )}
              >
                {slot.rows.map((inner, innerIndex) => drawRow(inner, innerIndex, slot))}
              </div>
            );
          }
          const node = draw(slot);
          return stacked(slot, editing ? editing({ widget: slot, row, rowIndex, column, index, node }) : node);
        })}
      </div>
    );
  }

  // On a portrait screen the rows and columns dissolve and every widget is one
  // full-width region placed by its type's `stackOrder`; in the TV's layout
  // this wrapper is no box at all.
  function stacked(widget: WallWidget, node: ReactNode): ReactNode {
    return (
      <div
        key={widget.id}
        data-wall-slot={widget.type}
        className="min-w-0 tv:contents"
        style={{ order: wallWidgetSpec(widget.type).stackOrder }}
      >
        {node}
      </div>
    );
  }

  return (
    <WallSeconds>
      {/* The one `fill` row takes what the others leave. */}
      <div className="flex min-h-0 flex-1 flex-col gap-wall-region" data-wall-canvas>
        {layout.rows.map((row, rowIndex) => drawRow(row, rowIndex, null))}
      </div>
    </WallSeconds>
  );
}
