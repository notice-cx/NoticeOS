import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { isWallColumn, type WallColumn, type WallLayout, type WallSlot } from "@shared/wall-layout";
import { cn } from "@/lib/utils";
import {
  WALL_SHARE_PRESETS,
  wallDividerSplit,
  wallPairWidths,
  wallRowMinHeight,
  wallShareLabel,
  wallSlotMinWidth,
  wallSlotName,
  wallStackSizes,
  type WallSpan,
} from "@/lib/wall-editor";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The drawn Wall's resizable runs, in the TV's own pixels: each top-level row
 * and each column row of several widgets (`x`, widths side by side), and each
 * column (`y`, its rows' heights).
 */
export interface WallDividerGeometry {
  tracks: {
    /** The row's id, or the column's for a `y` track. */
    rowId: string;
    axis: "x" | "y";
    box: Box;
    /** Left to right, or top to bottom: slot or widget ids on `x`, column-row ids on `y`. */
    items: { id: string; box: Box }[];
  }[];
}

type Track = WallDividerGeometry["tracks"][number];

export interface WallDividersProps {
  layout: WallLayout;
  geometry: WallDividerGeometry;
  /** The stage's scale, so a handle keeps its real size on the picture. */
  scale: number;
  onWidths?: (widths: Record<string, number>, gesture: string) => void;
  onSizes?: (sizes: Record<string, number>, gesture: string) => void;
}

/** A slot or widget by id, wherever it sits, and its column when it is one. */
function findSlot(layout: WallLayout, id: string): WallSlot | null {
  for (const row of layout.rows) {
    for (const slot of row.widgets) {
      if (slot.id === id) return slot;
      if (!isWallColumn(slot)) continue;
      for (const inner of slot.rows) {
        const widget = inner.widgets.find((w) => w.id === id);
        if (widget) return widget;
      }
    }
  }
  return null;
}

function findColumn(layout: WallLayout, id: string): WallColumn | null {
  const slot = findSlot(layout, id);
  return slot && isWallColumn(slot) ? slot : null;
}

/** TV pixels a divider stops short of a neighbour's minimum. */
const MIN_MARGIN = 28;

const span = (box: Box, axis: "x" | "y"): WallSpan =>
  axis === "x" ? { start: box.left, size: box.width } : { start: box.top, size: box.height };

/**
 * The handles between neighbours on the stage. Dragging one moves the
 * boundary live, snaps to a quarter, a third, a half, two thirds or three
 * quarters of the row (or the column), stops at either neighbour's legible
 * minimum and shows both shares while it moves; the whole drag is one Undo.
 * Each is a focusable separator: the arrow keys move it a step and Page Up or
 * Page Down jump to the next preset.
 */
export function WallDividers({ layout, geometry, scale, onWidths, onSizes }: WallDividersProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-wall-dividers>
      {geometry.tracks.flatMap((track) =>
        track.items.slice(0, -1).map((item, index) => {
          const next = track.items[index + 1];
          if (!next) return null;
          if (track.axis === "x" && !onWidths) return null;
          if (track.axis === "y" && !onSizes) return null;
          return (
            <WallDivider
              key={`${track.rowId}:${item.id}:${next.id}`}
              layout={layout}
              track={track}
              index={index}
              scale={scale}
              onWidths={onWidths}
              onSizes={onSizes}
            />
          );
        }),
      )}
    </div>
  );
}

function WallDivider({
  layout,
  track,
  index,
  scale,
  onWidths,
  onSizes,
}: {
  layout: WallLayout;
  track: Track;
  index: number;
  scale: number;
  onWidths?: WallDividersProps["onWidths"];
  onSizes?: WallDividersProps["onSizes"];
}) {
  const first = track.items[index];
  const second = track.items[index + 1];
  const [active, setActive] = useState<{ label: string } | null>(null);
  /** The geometry the gesture started from: the picture moves under the
   * pointer as it redraws, so every step is measured against the start. */
  const start = useRef<{ track: Track; gesture: string } | null>(null);
  const keyGesture = useRef<string | null>(null);
  if (!first || !second) return null;

  const vertical = track.axis === "x";
  const firstSlot = vertical ? findSlot(layout, first.id) : null;
  const secondSlot = vertical ? findSlot(layout, second.id) : null;
  const column = vertical ? null : findColumn(layout, track.rowId);
  const firstRow = column?.rows.find((row) => row.id === first.id) ?? null;
  const secondRow = column?.rows.find((row) => row.id === second.id) ?? null;
  const names = [wallSlotName(layout, first.id), wallSlotName(layout, second.id)];

  const minFirst = vertical ? (firstSlot ? wallSlotMinWidth(firstSlot) : 0) : firstRow ? wallRowMinHeight(firstRow) : 0;
  const minSecond = vertical ? (secondSlot ? wallSlotMinWidth(secondSlot) : 0) : secondRow ? wallRowMinHeight(secondRow) : 0;

  /** Apply the boundary at `pointer` (TV pixels along the axis) to the layout. */
  const apply = (from: Track, pointer: number, gesture: string, snap = true) => {
    const split = wallDividerSplit({
      items: from.items.map((item) => span(item.box, from.axis)),
      index,
      pointer,
      // A step clear of the line the too-small state draws at, so a divider
      // stopped at a minimum never shows it.
      minFirst: minFirst + MIN_MARGIN,
      minSecond: minSecond + MIN_MARGIN,
      snap,
    });
    if (vertical) {
      if (!firstSlot || !secondSlot || !onWidths) return null;
      const [wa, wb] = wallPairWidths(firstSlot.width, secondSlot.width, split.ratio);
      onWidths({ [firstSlot.id]: wa, [secondSlot.id]: wb }, gesture);
    } else {
      if (!column || !onSizes) return null;
      const heights = from.items.map((item) => item.box.height);
      onSizes(wallStackSizes(column, heights, index, split.ratio), gesture);
    }
    return `${wallShareLabel(split.firstShare)} · ${wallShareLabel(split.secondShare)}`;
  };

  const boundary = vertical
    ? (first.box.left + first.box.width + second.box.left) / 2
    : (first.box.top + first.box.height + second.box.top) / 2;
  const spans = track.items.map((item) => span(item.box, track.axis));
  const total = spans.reduce((sum, item) => sum + item.size, 0) || 1;
  const before = spans.slice(0, index).reduce((sum, item) => sum + item.size, 0);
  const firstSize = spans[index]?.size ?? 0;
  /** The share of the run's widgets before the divider: where it stands. */
  const position = (before + firstSize) / total;
  const hit = 14 / scale;
  const shareOf = (box: Box) => wallShareLabel((vertical ? box.width : box.height) / total);
  /** Both neighbours' shares of the row (or column), as drawn now. */
  const shares = `${shareOf(first.box)} · ${shareOf(second.box)}`;

  const toCanvas = (event: PointerEvent<HTMLDivElement>) => {
    const stage = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!stage) return 0;
    return vertical ? (event.clientX - stage.left) / scale : (event.clientY - stage.top) / scale;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { track: structuredClone(track), gesture: `divider:${track.rowId}:${index}:${Date.now()}` };
    setActive({ label: shares });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const label = apply(start.current.track, toCanvas(event), start.current.gesture);
    if (label) setActive({ label });
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    start.current = null;
    setActive(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forth = vertical ? "ArrowRight" : "ArrowDown";
    let target: number | null = null;
    if (event.key === back || event.key === forth) {
      target = boundary + (event.key === forth ? 1 : -1) * total * 0.02;
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      const forward = event.key === "PageDown";
      const presets = WALL_SHARE_PRESETS.map((p) => p.share);
      const nextShare = forward
        ? presets.find((share) => share > position + 0.005)
        : [...presets].reverse().find((share) => share < position - 0.005);
      if (nextShare !== undefined) target = boundary + (nextShare - position) * total;
    }
    if (target === null) return;
    event.preventDefault();
    keyGesture.current ??= `divider-keys:${track.rowId}:${index}:${Date.now()}`;
    const label = apply(track, target, keyGesture.current, event.key.startsWith("Page"));
    if (label) setActive({ label });
  };

  const box = vertical
    ? { left: boundary - hit / 2, top: track.box.top, width: hit, height: track.box.height }
    : { left: track.box.left, top: boundary - hit / 2, width: track.box.width, height: hit };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={vertical ? `Resize, left ${names[0]}, right ${names[1]}` : `Resize, above ${names[0]}, below ${names[1]}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position * 100)}
      aria-valuetext={`${names[0]} ${shareOf(first.box)}, ${names[1]} ${shareOf(second.box)}`}
      data-wall-divider={`${track.axis}:${first.id}:${second.id}`}
      className={cn(
        "group pointer-events-auto absolute flex touch-none items-center justify-center outline-none",
        vertical ? "cursor-col-resize" : "cursor-row-resize",
      )}
      style={box}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onBlur={() => {
        keyGesture.current = null;
        setActive(null);
      }}
    >
      {/* The line the boundary is, shown while the handle is pointed at,
          focused or dragged. */}
      <span
        aria-hidden
        className={cn(
          "absolute bg-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          active && "opacity-100",
        )}
        style={vertical ? { width: 2 / scale, top: 0, bottom: 0 } : { height: 2 / scale, left: 0, right: 0 }}
      />
      <span
        aria-hidden
        className={cn(
          "relative rounded-full border border-background bg-muted-foreground/80 shadow group-hover:bg-primary group-focus-visible:bg-primary",
          active && "bg-primary",
        )}
        style={vertical ? { width: 6 / scale, height: 36 / scale } : { width: 36 / scale, height: 6 / scale }}
      />
      {active ? (
        <span
          className="absolute whitespace-nowrap rounded-md bg-primary px-2 py-0.5 text-xs font-medium tabular-nums text-primary-foreground shadow"
          style={{ transform: `scale(${1 / scale})` }}
          data-wall-divider-readout
        >
          {active.label}
        </span>
      ) : null}
    </div>
  );
}
