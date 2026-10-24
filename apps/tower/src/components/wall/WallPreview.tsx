import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/utils/pointer-outside-of-preview";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview";
import { GripVertical, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { CalendarUpcoming, Ga4RealtimePayload } from "@noticeos/contract";
import type { ConnectionReads } from "@shared/connection-status";
import type { WallPayload } from "@shared/wall";
import { measureWallFit } from "../../../../../scripts/wall-fit-measure.mjs";
import {
  WALL_TV_HEIGHT,
  WALL_TV_WIDTH,
  WALL_WIDGET_LIBRARY,
  wallTvViewport,
  type WallTvPreset,
  type WallLayout,
  type WallWidgetType,
} from "@shared/wall-layout";
import { DropLine } from "@/components/DropLine";
import { WallCanvas } from "@/components/WallCanvas";
import { WallDividers, type WallDividerGeometry } from "@/components/wall/WallDividers";
import { WallMoveMenu } from "@/components/wall/WallMoveMenu";
import type { WallMetricEditing } from "@/components/wall/WallMetricEditing";
import { Button } from "@/components/ui/button";
import type { CalendarReadState } from "@/lib/meetings";
import { cn } from "@/lib/utils";
import { wallViewportScreen } from "@/lib/wall-screen";
import {
  wallDropEdge,
  wallDropPlan,
  wallPositionSentence,
  wallSlotName,
  type WallDragSource,
  type WallDropLine,
  type WallDropTarget,
  type WallMove,
} from "@/lib/wall-editor";

/** Below this scale the counter-scaled chrome would cover the widget it sits
 * on, so it is not drawn and every action lives in the widget panel. */
const CHROME_MIN_SCALE = 0.25;

/** What a drag carries, under one key no other drag on the page uses. */
const SOURCE_KEY = "wallSource";
const TARGET_KEY = "wallTarget";

/** A drag that belongs to this editor: a widget, or one from the Add drawer. */
export function wallDragData(source: WallDragSource): Record<string, unknown> {
  return { [SOURCE_KEY]: source };
}

function sourceOf(data: Record<string | symbol, unknown>): WallDragSource | null {
  const source = data[SOURCE_KEY];
  return source && typeof source === "object" ? (source as WallDragSource) : null;
}

function targetOf(data: Record<string | symbol, unknown> | undefined): WallDropTarget | null {
  const target = data?.[TARGET_KEY];
  return target && typeof target === "object" ? (target as WallDropTarget) : null;
}

/** The small label a dragged widget becomes under the pointer: the TV's
 * picture of a widget is too big to carry around. */
export function wallDragPreview(type: WallWidgetType, nativeSetDragImage: Parameters<typeof setCustomNativeDragPreview>[0]["nativeSetDragImage"]) {
  setCustomNativeDragPreview({
    nativeSetDragImage,
    getOffset: pointerOutsideOfPreview({ x: "12px", y: "8px" }),
    render: ({ container }) => {
      const chip = document.createElement("div");
      chip.className = "rounded-md border border-primary bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-xl";
      chip.textContent = WALL_WIDGET_LIBRARY[type].label;
      container.appendChild(chip);
    },
  });
}

/** A box in the renderer's logical pixels, before its screen and preview projection. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What the stage measures of the drawn Wall after every change. */
interface StageGeometry extends WallDividerGeometry {
  /** Each top-level row's box, in order. */
  rows: Box[];
  /** Each widget's box, by id. */
  widgets: Record<string, Box>;
  /** Each column's box, by id. */
  columns: Record<string, Box>;
  /** Each row's box (top-level and inside columns), by id. */
  rowsById: Record<string, Box>;
  tooSmall: Record<string, "narrow" | "short">;
}

const NO_GEOMETRY: StageGeometry = { rows: [], widgets: {}, columns: {}, rowsById: {}, tracks: [], tooSmall: {} };

/** A box relative to the canvas, in the TV's pixels. */
function canvasBox(element: Element, origin: DOMRect, scale: number): Box {
  const rect = element.getBoundingClientRect();
  return {
    left: (rect.left - origin.left) / scale,
    top: (rect.top - origin.top) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}

/** Read the drawn Wall's boxes, top-level rows, columns and widgets. */
function measure(box: HTMLElement, scale: number): StageGeometry {
  const canvas = box.querySelector("[data-wall-canvas]");
  if (!canvas || scale <= 0) return NO_GEOMETRY;
  const origin = box.getBoundingClientRect();
  // Not laid out yet (or no layout engine at all): nothing to measure, and
  // zero-sized boxes would read as every widget drawn too small.
  if (origin.width === 0 || origin.height === 0) return NO_GEOMETRY;
  const at = (el: Element) => canvasBox(el, origin, scale);
  const geometry: StageGeometry = { rows: [], widgets: {}, columns: {}, rowsById: {}, tracks: [], tooSmall: {} };
  for (const el of box.querySelectorAll("[data-wall-edit-widget]")) {
    const id = el.getAttribute("data-wall-edit-widget");
    if (id) {
      geometry.widgets[id] = at(el);
      const content = el.querySelector("[data-wall-widget-content]");
      if (!content) continue;
      const fit = measureWallFit({ root: content, scale });
      if ("error" in fit) continue;
      if (fit.counts.overX || [...fit.ink, ...fit.clipped].some(leak => leak.axis === "x")) geometry.tooSmall[id] = "narrow";
      else if (fit.counts.overY || [...fit.ink, ...fit.clipped].some(leak => leak.axis === "y")) geometry.tooSmall[id] = "short";
    }
  }
  for (const el of box.querySelectorAll("[data-wall-column]")) {
    const id = el.getAttribute("data-wall-column");
    if (id) geometry.columns[id] = at(el);
  }
  for (const el of box.querySelectorAll("[data-wall-row]")) {
    const id = el.getAttribute("data-wall-row");
    if (id) geometry.rowsById[id] = at(el);
  }
  // A row's grid items, left to right: a column box, or a widget's own box
  // (its stacking wrapper is no box at the TV's width).
  const itemsOf = (row: Element) =>
    [...row.children].flatMap((child) => {
      const columnId = child.getAttribute("data-wall-column");
      if (columnId) return [{ id: columnId, box: at(child) }];
      const widget = child.querySelector(":scope > [data-wall-edit-widget]");
      const id = widget?.getAttribute("data-wall-edit-widget");
      return widget && id ? [{ id, box: at(widget) }] : [];
    });
  for (const row of canvas.querySelectorAll(":scope > [data-wall-row]")) {
    geometry.rows.push(at(row));
    const id = row.getAttribute("data-wall-row") ?? "";
    geometry.tracks.push({ rowId: id, axis: "x", box: at(row), items: itemsOf(row) });
  }
  for (const column of canvas.querySelectorAll("[data-wall-column]")) {
    const id = column.getAttribute("data-wall-column") ?? "";
    const inner = [...column.children].filter((child) => child.hasAttribute("data-wall-row"));
    geometry.tracks.push({
      rowId: id,
      axis: "y",
      box: at(column),
      items: inner.map((row) => ({ id: row.getAttribute("data-wall-row") ?? "", box: at(row) })),
    });
    for (const row of inner) {
      const items = itemsOf(row);
      if (items.length > 1) geometry.tracks.push({ rowId: row.getAttribute("data-wall-row") ?? "", axis: "x", box: at(row), items });
    }
  }
  geometry.tracks.push({
    rowId: "canvas",
    topLevel: true,
    axis: "y",
    box: at(canvas),
    items: [...canvas.querySelectorAll(":scope > [data-wall-row]")].map(row => ({
      id: row.getAttribute("data-wall-row") ?? "", box: at(row),
    })),
  });
  return geometry;
}

/** The line a landing draws, in canvas pixels: three screen pixels thick and
 * just outside the edge it names, plus the words for where it lands. */
function lineBox(line: WallDropLine, geometry: StageGeometry, scale: number, nameOf: (id: string) => string): (Box & { label: string }) | null {
  const thick = 3 / scale;
  if (line.anchor === "gap") {
    const rows = geometry.rows;
    const above = rows[line.index - 1];
    const below = rows[line.index];
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return null;
    const left = Math.min(...rows.map((r) => r.left));
    const right = Math.max(...rows.map((r) => r.left + r.width));
    const y = above && below ? (above.top + above.height + below.top) / 2 : below ? below.top - thick : last.top + last.height + thick;
    return { left, top: y - thick / 2, width: right - left, height: thick, label: "New row" };
  }
  const box =
    line.anchor === "slot" ? geometry.columns[line.id] : line.anchor === "row" ? geometry.rowsById[line.id] : geometry.widgets[line.id];
  if (!box) return null;
  const pad = 6;
  const where = { top: "Above", bottom: "Below", left: "Left of", right: "Right of" }[line.edge];
  const label = `${where} ${nameOf(line.id)}`;
  switch (line.edge) {
    case "top":
      return { left: box.left, top: box.top - pad - thick / 2, width: box.width, height: thick, label };
    case "bottom":
      return { left: box.left, top: box.top + box.height + pad - thick / 2, width: box.width, height: thick, label };
    case "left":
      return { left: box.left - pad - thick / 2, top: box.top, width: thick, height: box.height, label };
    case "right":
      return { left: box.left + box.width + pad - thick / 2, top: box.top, width: thick, height: box.height, label };
  }
}

/** Where a landing line's words go: beside the line on the landing side, at
 * the chrome's real size (`scale` first, so the shifts are the label's own). */
function labelPlace(edge: "top" | "bottom" | "left" | "right" | "gap", scale: number): CSSProperties {
  const shift = {
    top: { left: "50%", top: "100%", move: "translate(-50%, 4px)" },
    bottom: { left: "50%", top: "0", move: "translate(-50%, calc(-100% - 4px))" },
    left: { left: "100%", top: "50%", move: "translate(4px, -50%)" },
    right: { left: "0", top: "50%", move: "translate(calc(-100% - 4px), -50%)" },
    gap: { left: "50%", top: "50%", move: "translate(-50%, -50%)" },
  }[edge];
  return { left: shift.left, top: shift.top, transformOrigin: "0 0", transform: `scale(${scale}) ${shift.move}` };
}

export interface WallPreviewProps {
  tvPreset?: WallTvPreset;
  layout: WallLayout;
  data: WallPayload;
  meetings?: CalendarUpcoming | null;
  calendarState?: CalendarReadState;
  ga4Realtime?: Ga4RealtimePayload;
  ga4RealtimeError?: boolean;
  /** The reads each source mark's status comes from, as on the TV. */
  connections?: ConnectionReads;
  nowMs: number;
  selectedId: string | null;
  onSelect: (widgetId: string | null) => void;
  onRemove: (widgetId: string) => void;
  /** A drag landed where its line promised. */
  onDrop?: (source: WallDragSource, target: WallDropTarget) => void;
  /** A Move menu item, or its Alt+arrow shortcut on a focused widget. */
  onMove?: (widgetId: string, move: WallMove) => void;
  /** A divider's drag or key: widths by slot id, one gesture per drag. */
  onWidths?: (widths: Record<string, number>, gesture: string) => void;
  /** A stacked divider's drag or key: column-row height weights. */
  onSizes?: (sizes: Record<string, number>, gesture: string) => void;
  /** The widget that just landed, drawn with a brief ring. */
  flashId?: string | null;
  /** Arranging is offered only where it can be saved. */
  disabled?: boolean;
  /** Fit the whole television into the window's height too, not only the
   * pane's width, so the picture being arranged is always all in view. */
  fitHeight?: boolean;
  /** Room for the selected tile's controls below the full-Wall preview. */
  reservedHeight?: number;
  /** Content height in the selected CSS viewport's pixels, excluding preview fitting. */
  onMeasure?: (contentHeightPx: number) => void;
  onPortfolioFit?: (fit: { visible: number; total: number } | null) => void;
  className?: string;
  metricEditing?: WallMetricEditing;
}

/**
 * The Wall at TV geometry, as the stage the operator arranges it on. It is the
 * real renderer (`WallCanvas` in the selected TV's box, scaled by a
 * transform) and the real breakpoints (`wall-root` is the `wall` query
 * container). Each widget is a drag source and a drop target: the edge the
 * pointer is nearest decides where it lands, and a line over the picture says
 * so before the drop. During a drag, a band between rows takes a new row.
 * Metric tiles keep individual selection targets; their sections drag by the
 * grip. Other sections use the whole frame as the selection and drag target.
 */
export function WallPreview({
  layout,
  data,
  meetings,
  calendarState,
  ga4Realtime,
  ga4RealtimeError,
  connections,
  nowMs,
  selectedId,
  onSelect,
  onRemove,
  onDrop,
  onMove,
  onWidths,
  onSizes,
  flashId = null,
  disabled = false,
  fitHeight = false,
  reservedHeight = 0,
  onMeasure,
  onPortfolioFit,
  className,
  metricEditing,
  tvPreset,
}: WallPreviewProps) {
  const viewport = tvPreset ? wallTvViewport(tvPreset) : { width: WALL_TV_WIDTH, height: WALL_TV_HEIGHT };
  const screen = wallViewportScreen(viewport.width, viewport.height);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [contentHeight, setContentHeight] = useState(screen.height);
  const scale = fitScale * screen.zoom;
  const scrolls = screen.layout === 'stack' && !screen.kiosk;
  const projectedHeight = scrolls ? Math.max(viewport.height * fitScale, contentHeight * scale) : viewport.height * fitScale;
  const [hovered, setHovered] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<StageGeometry>(NO_GEOMETRY);
  const [dragging, setDragging] = useState<WallDragSource | null>(null);
  const [landing, setLanding] = useState<{ target: WallDropTarget; line: WallDropLine } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  // The pane's width, and with `fitHeight` the window's height below the
  // frame's top, decide the scale; a frame not yet laid out draws at natural
  // size rather than dividing by zero.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measureScale = () => {
      const rect = frame.getBoundingClientRect();
      const byWidth = rect.width > 0 ? rect.width / viewport.width : 1;
      const room = Math.max(320, window.innerHeight - Math.max(0, rect.top) - 24 - reservedHeight);
      const byHeight = fitHeight && room > 240 ? room / viewport.height : Number.POSITIVE_INFINITY;
      setFitScale(Math.min(byWidth, byHeight));
    };
    measureScale();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureScale);
      return () => window.removeEventListener("resize", measureScale);
    }
    const observer = new ResizeObserver(measureScale);
    observer.observe(frame);
    window.addEventListener("resize", measureScale);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureScale);
    };
  }, [fitHeight, reservedHeight, viewport.width, viewport.height]);

  // Observe content only: selection chrome and fit notes cannot trigger
  // their own measurements. Widget reflows and font loads settle in one frame.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let frame = 0;
    let live = true;
    const read = () => {
      frame = 0;
      const next = measure(box, scale);
      setGeometry(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      // Drag targets and landing lines are siblings of the TV canvas. Their
      // editor-only overflow must never become a TV overflow warning.
      const canvas = box.querySelector<HTMLElement>("[data-wall-canvas]");
      const paddingBottom = Number.parseFloat(getComputedStyle(box).paddingBottom) || 0;
      const height = canvas ? Math.max(box.clientHeight, canvas.offsetTop + canvas.scrollHeight + paddingBottom) : box.clientHeight;
      setContentHeight(current => current === height ? current : height);
      onMeasure?.(height * screen.zoom);
      const list = canvas?.querySelector(".wall-portfolio-list");
      const rows = list ? [...list.querySelectorAll("[data-site-row]")] : [];
      const bounds = list?.getBoundingClientRect();
      if (bounds && bounds.height > 0) {
        const viewport = (box.closest('[data-wall-preview]') ?? box).getBoundingClientRect();
        const visible = rows.filter(row => {
          const rect = row.getBoundingClientRect();
          return rect.top >= Math.max(bounds.top, viewport.top) - 1 && rect.bottom <= Math.min(bounds.bottom, viewport.bottom) + 1;
        }).length;
        onPortfolioFit?.({ visible, total: rows.length });
      } else onPortfolioFit?.(null);
    };
    const schedule = () => {
      if (live && !frame) frame = requestAnimationFrame(read);
    };
    read();
    const observer = new MutationObserver(schedule);
    for (const content of box.querySelectorAll("[data-wall-widget-content]")) {
      observer.observe(content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
    }
    void document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    return () => {
      live = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [layout, data, meetings, calendarState, ga4Realtime, ga4RealtimeError, connections, nowMs, scale, screen.zoom, screen.width, screen.height, onMeasure, onPortfolioFit]);

  // One watcher for every drag on the page that belongs to this editor: it
  // asks the grammar what the drop under the pointer would do and draws the
  // answer, or nothing where the answer is no.
  useEffect(() => {
    if (disabled) return;
    const plan = (source: WallDragSource, data: Record<string | symbol, unknown> | undefined) => {
      const target = targetOf(data);
      if (!target) return null;
      const result = wallDropPlan(layoutRef.current, source, target);
      return result ? { target, line: result.line } : null;
    };
    return monitorForElements({
      canMonitor: ({ source }) => sourceOf(source.data) !== null,
      onDragStart: ({ source }) => {
        setDragging(sourceOf(source.data));
        setLanding(null);
      },
      onDrag: ({ source, location }) => {
        const from = sourceOf(source.data);
        const next = from ? plan(from, location.current.dropTargets[0]?.data) : null;
        setLanding((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      },
      onDrop: ({ source, location }) => {
        const from = sourceOf(source.data);
        const landed = from ? plan(from, location.current.dropTargets[0]?.data) : null;
        setDragging(null);
        setLanding(null);
        if (from && landed) onDropRef.current?.(from, landed.target);
      },
    });
  }, [disabled]);

  const chromeScale = scale > 0 ? 1 / scale : 1;
  const line = landing ? lineBox(landing.line, geometry, scale, (id) => wallSlotName(layout, id)) : null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        ref={frameRef}
        // A transform does not change layout, so the frame reserves the
        // scaled box's height itself.
        style={{ height: `${viewport.height * fitScale}px` }}
        className="w-full"
      >
        <div
          style={{ width: `${viewport.width * fitScale}px`, height: `${viewport.height * fitScale}px` }}
          className={cn("mx-auto overflow-x-hidden border border-border bg-background text-foreground", scrolls ? "overflow-y-auto" : "overflow-y-hidden")}
          // The TV never draws light, but this box sits inside the desk's
          // `.light`; `data-theme="dark"` re-declares the dark tokens here.
          data-theme="dark"
          data-wall-preview
          data-wall-preview-scale={scale.toFixed(3)}
          data-wall-preview-fit-scale={fitScale.toFixed(6)}
          data-wall-preview-width={viewport.width}
          data-wall-preview-height={viewport.height}
          data-wall-preview-content-height={projectedHeight}
          data-wall-dragging={dragging ? "" : undefined}
        >
          <div className="relative overflow-hidden" style={{ width: `${viewport.width * fitScale}px`, height: `${projectedHeight}px` }}>
          <div
            ref={boxRef}
            // `wall-root` is the television's scope and the `wall` query
            // container, as `WallRoute` puts it above the canvas. The padding is
            // the TV route's own, resolved: a container cannot query itself, and
            // this box uses the selected viewport's logical rendering size.
            className="wall-root absolute left-0 top-0 flex flex-col bg-background px-wall-inset-x py-wall-inset-y"
            data-wall-screen
            data-wall-kiosk={screen.kiosk || undefined}
            data-wall-compact={screen.compact || undefined}
            data-wall-small-insets={screen.viewportWidth < 768 || undefined}
            data-wall-scaled={screen.scale < 1 || undefined}
            data-wall-logical-width={screen.width}
            data-wall-logical-height={screen.height}
            style={
              {
                width: `${screen.width}px`,
                height: scrolls ? 'auto' : `${screen.height}px`,
                minHeight: `${screen.height}px`,
                zoom: 1,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                // Read by the chrome, so a control keeps its real size.
                "--wall-chrome-scale": chromeScale,
                "--wall-scale": screen.scale,
                "--wall-render-zoom": screen.zoom,
                "--wall-viewport-height": `${viewport.height}px`,
              } as CSSProperties
            }
          >
            <WallCanvas
              layout={layout}
              data={data}
              meetings={meetings}
              calendarState={calendarState}
              ga4Realtime={ga4Realtime}
              ga4RealtimeError={ga4RealtimeError}
              connections={connections}
              nowMs={nowMs}
              // A "reconnecting" note inside a preview would read as a fault in
              // the layout being arranged.
              lastGood={false}
              metricEditing={metricEditing}
              editing={({ widget, node }) => (
                <WallStageWidget
                  key={widget.id}
                  layout={layout}
                  widgetId={widget.id}
                  type={widget.type}
                  node={node}
                  selected={widget.id === selectedId}
                  // One toolbar at a time, over the widget being pointed at.
                  chrome={scale >= CHROME_MIN_SCALE && (widget.id === selectedId || hovered === widget.id) && !dragging}
                  flash={widget.id === flashId}
                  lifted={dragging?.kind === "widget" && dragging.widgetId === widget.id}
                  small={geometry.tooSmall[widget.id] ?? null}
                  disabled={disabled}
                  metricInteractive={metricEditing !== undefined && ["sites", "work", "revenue"].includes(widget.type)}
                  onHover={(on) => setHovered((id) => (on ? widget.id : id === widget.id ? null : id))}
                  onSelect={() => onSelect(widget.id)}
                  onRemove={() => onRemove(widget.id)}
                  onMove={onMove ? (move) => onMove(widget.id, move) : undefined}
                />
              )}
            />
            {dragging ? <WallRowBands rows={geometry.rows} scale={scale} /> : null}
            {!dragging && !disabled && scale >= CHROME_MIN_SCALE && (onWidths || onSizes) ? (
              <WallDividers
                layout={layout}
                geometry={geometry}
                scale={scale}
                onWidths={onWidths}
                onSizes={onSizes}
              />
            ) : null}
            {line ? (
              <DropLine
                marks={{ "data-wall-drop-line": landing?.line.anchor === "gap" ? "gap" : landing?.line.edge }}
                box={{ left: line.left, top: line.top, width: line.width, height: line.height }}
                label={line.label}
                // The words sit on the side of the line the widget lands on,
                // so a line at the TV's own edge keeps them in view.
                labelStyle={labelPlace(landing?.line.anchor === "gap" ? "gap" : landing?.line.edge ?? "gap", chromeScale)}
              />
            ) : null}
          </div>
          </div>
        </div>
      </div>
      <p className="text-xs leading-snug text-muted-foreground" data-wall-preview-note>
        <span className="tabular-nums">TV · {viewport.width}×{viewport.height}, scaled to fit</span>
        {onDrop && !disabled && scale >= CHROME_MIN_SCALE ? (
          <span data-wall-preview-hint>
            {metricEditing ? " · Select a tile to edit. Drag a section by its grip to move it." : " · Drag a widget onto another’s edge to move it. Drag a handle between widgets to resize."}
          </span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The bands between the Wall's rows while something is dragged: a drop on one
 * starts a new row there. Sixteen screen pixels tall whatever the scale, and
 * centred on the gap so they take the very edge of the rows beside them.
 */
function WallRowBands({ rows, scale }: { rows: Box[]; scale: number }) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return null;
  const left = Math.min(...rows.map((r) => r.left));
  const right = Math.max(...rows.map((r) => r.left + r.width));
  const tall = 16 / scale;
  const ys = rows.map((row, i) => {
    const above = rows[i - 1];
    return above ? (above.top + above.height + row.top) / 2 : row.top - tall / 2;
  });
  ys.push(last.top + last.height + tall / 2);
  return (
    <>
      {ys.map((y, index) => (
        <WallRowBand key={index} index={index} box={{ left, top: y - tall / 2, width: right - left, height: tall }} />
      ))}
    </>
  );
}

function WallRowBand({ index, box }: { index: number; box: Box }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => sourceOf(source.data) !== null,
      getData: () => ({ [TARGET_KEY]: { kind: "gap", index } satisfies WallDropTarget }),
    });
  }, [index]);
  return (
    <div
      ref={ref}
      aria-hidden
      data-wall-row-band={index}
      className="absolute z-20"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />
  );
}

/**
 * One widget on the stage: the TV's own picture of it, with the editor's
 * frame. The frame is the selection target, the drag source and the drop
 * target; its toolbar (grip, name, Move, Remove) counter-scales so it keeps
 * its real size on a picture drawn at a third of the TV's.
 */
function WallStageWidget({
  layout,
  widgetId,
  type,
  node,
  selected,
  chrome,
  flash,
  lifted,
  small,
  disabled,
  metricInteractive = false,
  onHover,
  onSelect,
  onRemove,
  onMove,
}: {
  layout: WallLayout;
  widgetId: string;
  type: WallWidgetType;
  node: ReactNode;
  selected: boolean;
  chrome: boolean;
  flash: boolean;
  lifted: boolean;
  small: "narrow" | "short" | null;
  disabled: boolean;
  metricInteractive?: boolean;
  onHover: (on: boolean) => void;
  onSelect: () => void;
  onRemove: () => void;
  onMove?: (move: WallMove) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const gripRef = useRef<HTMLSpanElement | null>(null);
  const spec = WALL_WIDGET_LIBRARY[type];
  const position = wallPositionSentence(layout, widgetId);

  useEffect(() => {
    const element = ref.current;
    if (!element || disabled) return;
    return combine(
      ...(metricInteractive && !gripRef.current ? [] : [draggable({
        element,
        ...(metricInteractive && gripRef.current ? { dragHandle: gripRef.current } : {}),
        getInitialData: () => wallDragData({ kind: "widget", widgetId }),
        onGenerateDragPreview: ({ nativeSetDragImage }) => wallDragPreview(type, nativeSetDragImage),
        onDragStart: () => onSelect(),
      })]),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => sourceOf(source.data) !== null,
        getData: ({ input, element: target }) => ({
          [TARGET_KEY]: {
            kind: "widget",
            widgetId,
            edge: wallDropEdge(target.getBoundingClientRect(), input.clientX, input.clientY),
          } satisfies WallDropTarget,
        }),
      }),
    );
    // `onSelect` is a fresh closure each render; the drag only needs the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetId, type, disabled, metricInteractive, chrome]);

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey && onMove) {
      const move = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[
        event.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
      ];
      if (move) {
        event.preventDefault();
        onMove(move);
        return;
      }
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };

  return (
    <div
      ref={ref}
      role={metricInteractive ? "group" : "button"}
      tabIndex={0}
      aria-pressed={metricInteractive ? undefined : selected}
      aria-label={position ?? spec.label}
      aria-keyshortcuts={onMove ? "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight" : undefined}
      data-wall-edit-widget={widgetId}
      data-selected={selected ? "" : undefined}
      data-flash={flash ? "" : undefined}
      data-too-small={small ?? undefined}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHover(false);
      }}
      onClick={onSelect}
      onKeyDown={keys}
      className={cn(
        "relative min-h-0 min-w-0 outline-none ring-inset transition-shadow duration-700",
        // Empty sections still need room for the counter-scaled section grip.
        metricInteractive && "min-h-[calc(var(--spacing)*9*var(--wall-chrome-scale,1))]",
        !metricInteractive && (disabled ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"),
        "ring-1 ring-border/60 hover:ring-foreground/50 focus-visible:ring-4 focus-visible:ring-ring",
        selected && "ring-4 ring-primary",
        flash && "ring-8 ring-primary/70 duration-0",
        lifted && "opacity-40",
      )}
    >
      <div className={cn("h-full", !metricInteractive && "pointer-events-none")} data-wall-widget-content aria-hidden={metricInteractive ? undefined : true}>
        {node}
      </div>
      {small ? (
        // Drawn below its legible size, a chart would be cut; the state says
        // so instead, and resizing or moving it clears it.
        <div
          className="pointer-events-none absolute inset-0 grid place-items-center bg-background/85"
          data-wall-too-small-note
        >
          <span
            className="rounded-md border border-warn bg-card px-3 py-1.5 text-center text-sm font-medium text-warn"
            // Its real size, and never wider than the widget it is on: the
            // words wrap rather than spill onto the neighbour.
            style={{ transform: "scale(var(--wall-chrome-scale, 1))", maxWidth: "calc(100% / var(--wall-chrome-scale, 1))" }}
          >
            {small === "narrow" ? `Too narrow for ${spec.label}` : `Too short for ${spec.label}`}
          </span>
        </div>
      ) : null}
      {chrome ? (
        <div
          style={{ transform: "scale(var(--wall-chrome-scale, 1))", transformOrigin: "top left" }}
          className="absolute left-0 top-0 z-10 flex items-center gap-0.5 rounded-br-md bg-card/95 p-0.5 shadow-md"
          data-wall-edit-chrome
        >
          <span
            ref={gripRef}
            className="grid size-9 cursor-grab place-items-center text-muted-foreground active:cursor-grabbing"
            aria-hidden
            title={disabled ? undefined : `Drag to move ${spec.label}`}
          >
            <GripVertical className="size-4" />
          </span>
          <span className="pr-1.5 text-sm font-medium text-foreground" aria-hidden>
            {spec.label}
          </span>
          {onMove ? (
            <WallMoveMenu layout={layout} widgetId={widgetId} disabled={disabled} onMove={onMove} onRemove={onRemove} />
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${spec.label}`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
