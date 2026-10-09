// The Wall, drawn from a layout document (epic `ro-lzmq`, docs/15 flow D).
//
// WHAT CHANGED. Until 2026-09-05 `/wall` was a fixed tree in `WallRoute.tsx`:
// three rows, seven widgets, one configurable element (the countdown). This
// component takes that composition as DATA — a `WallLayout` from
// `shared/wall-layout`, saved at `config/tower.json` `/wall` — and draws it.
//
// ONE RENDERER, TWO SURFACES. The TV shows a `WallCanvas` and the editor's
// preview shows the same `WallCanvas`, because a preview drawn by a second
// component is a preview that can lie. The editor's own chrome — selection
// outlines, drag handles — arrives through the `editing` slot below and is
// never imported by `/wall`.
//
// THE ROW IS A GRID, AND ITS TRACKS ARE THE LAYOUT'S OWN. Each row is
// `minmax(<spec.minWidthRem>rem, <widget.width>fr)` per widget, in widget order:
// the weight is what the operator dragged, the floor is the width below which
// that widget's content clips (the hand-written grids carried the same pair as
// Tailwind arbitrary values). The tracks are an INLINE STYLE rather than a
// class because a class computed at runtime is a class Tailwind never generated
// — the token rule (doc 14) governs color, type and spacing, all of which are
// still classes here; a grid template derived from saved data is layout data.
//
// THE STRIP'S CLOCK TICKS ON ITS OWN SECOND. The strip's time, meeting and
// countdown age off a 1s tick held in a context below, so the site rows and
// charts are not redrawn sixty times a minute: everything else ages off the
// Wall's slow clock.
//
// D28 (bead `ro-trai.11`, docs/14-design.md): the five widgets below are the
// whole library. The old Wall's alert rail, portfolio and System cards, time
// panels and asset cards are retired types a saved layout may still name;
// `parseWallConfig` draws the default in their place, so none reaches here.

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
// READ-ONLY IMPORTS ONLY. `/wall` downloads everything this file imports, so
// every widget comes from a display module that edits and acts on nothing
// (bead `ro-ujb9.82`); the route-split journey fails if editing or task code,
// or a retired widget's module, reaches the TV again.
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
  /** Index of the widget in `row.widgets` — the layout's own index, not the
   * index among the widgets that happen to be visible, so a drop lands where
   * the operator aimed even when a neighbour is hiding. */
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
  /** Showing a held payload after a failed poll: the strip says so, with the
   * held payload's age (docs/25 § TV rules: last-good values with their age). */
  lastGood?: boolean;
  /** The credentials and monitoring reads every source mark is read from
   * (`sourceReadings`), the surface's own polls. */
  connections?: ConnectionReads;
  /**
   * The editor's slot. Whatever it returns REPLACES the widget in its own grid
   * track, so the wrapper controls the cell rather than sitting inside it. The
   * TV passes nothing and imports nothing about editing.
   */
  editing?: (slot: WallWidgetSlot) => ReactNode;
}

/** The one-second tick the strip's time, meeting and countdown share. */
const WallSecondsContext = createContext<number | null>(null);

/**
 * Holds that tick where only its consumers repaint: `children` arrives as a
 * prop, so React bails out of redrawing the element tree it already has and
 * re-renders the context's readers alone.
 */
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
 * The grid template one row's visible widgets produce: the library's floor and
 * the layout's weight, in widget order.
 *
 * These are TV tracks, drawn at the TV's width only (`tv:` in index.css) — on
 * the TV, in the editor's preview, and on a laptop or a landscape tablet,
 * which draw the TV's layout scaled (bead ro-trai.31). On a portrait tablet or
 * a phone the Wall is one column in a fixed reading order (`stacked` below),
 * so no weight is imposed there.
 *
 * A CAPPED WIDGET NEVER TAKES WHAT IS LEFT (bead ro-trai.31). A widget whose
 * spec has a `maxWidthRem` — the feed — keeps its share by weight until that
 * share reaches its cap; past it, the widgets beside it take the rest. That is
 * written as a floor on the UNCAPPED tracks — their weight's part of the row
 * less the gaps and the caps — so on the TV, where the feed's share (446 px)
 * is under its cap, the floor never binds and the tracks are exactly the
 * `fr` split they always were. So a wider screen widens the site rows, never
 * the feed past 30 rem.
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
        // Its own 30-second read (bead ro-trai.9): only a Wall that places the
        // feed asks for it.
        return <WallFeedWidget nowMs={nowMs} />;
    }
  }

  // Hiding is decided bottom-up: a widget with nothing to show yields its
  // track, a column row whose widgets all hide goes, and a column whose rows
  // all go yields its own track — an empty grid is the hole the rule exists to
  // prevent, at every level.
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
        // D28's frame (docs/25 § Budget): regions side by side 28px apart. A
        // row is a box only at the TV's width; below it, it dissolves into the
        // canvas's one column (`stacked` below).
        className={cn(
          "contents tv:grid tv:grid-cols-(--wall-row-tracks) tv:gap-x-wall-region-x tv:gap-y-wall-region",
          row.height === "fill" ? "tv:min-h-0 tv:flex-1" : null,
        )}
        style={{ "--wall-row-tracks": wallRowTracks(drawn.map((d) => d.slot)) } as CSSProperties}
      >
        {drawn.map(({ slot, index }) => {
          if (isWallColumn(slot)) {
            // A COLUMN (bead `ro-trai.2`) is one track of its row holding rows
            // of its own, stacked with the canvas's own rhythm; its `fill` row
            // takes the height its other rows leave, as the canvas's does.
            return (
              <div
                key={slot.id}
                data-wall-column={slot.id}
                className={cn(
                  "contents tv:flex tv:min-h-0 tv:min-w-0 tv:flex-col tv:gap-wall-region",
                  // The editor outlines the column so a stack reads as one
                  // thing; the TV draws no chrome.
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

  // A PORTRAIT SCREEN IS ONE COLUMN IN THE ORDER A PERSON READS THE BUSINESS
  // (operator 2026-09-23, beads ro-trai.24, ro-trai.29 and ro-trai.31,
  // docs/14-design.md § Laptop, tablet and phone). On a portrait tablet or a
  // phone the rows and columns above dissolve and every widget is one region
  // of the canvas's column, full width, placed by its type's `stackOrder`: the
  // strip, revenue, the site rows, Needs you, the feed — whatever arrangement
  // the TV was given. In the TV's layout (the TV, and a laptop or a landscape
  // tablet drawing it scaled) this wrapper is no box at all, so the Wall draws
  // exactly the layout document.
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
      {/* The canvas is the whole Wall inside the page inset (D28 has no
          header): rows 20px apart, and the one `fill` row takes what the
          others leave. */}
      <div className="flex min-h-0 flex-1 flex-col gap-wall-region" data-wall-canvas>
        {layout.rows.map((row, rowIndex) => drawRow(row, rowIndex, null))}
      </div>
    </WallSeconds>
  );
}
