import { GripVertical, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import type { Ga4RealtimePayload } from "@noticeos/contract";
import type { CalendarUpcoming } from "@noticeos/contract";
import type { ConnectionReads } from "@shared/connection-status";
import type { WallPayload } from "@shared/wall";
import {
  WALL_TV_HEIGHT,
  WALL_TV_WIDTH,
  WALL_WIDGET_LIBRARY,
  type WallLayout,
} from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";
import type { CalendarReadState } from "@/lib/meetings";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The native drag-and-drop type; a drop from anywhere else is ignored. */
export const WALL_DRAG_TYPE = "application/x-noticeos-wall-widget";

/** Below this scale the counter-scaled chrome would cover the widget it sits
 * on, so it is not drawn and every action lives in the widget panel. */
const CHROME_MIN_SCALE = 0.25;

export interface WallPreviewProps {
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
  /** A drop landed: this widget, into that row, before that index. */
  onMove: (widgetId: string, toRowId: string, toIndex: number) => void;
  /** The measured content height of the 1920×1080 canvas, after every change. */
  onMeasure?: (contentHeightPx: number) => void;
  className?: string;
}

/**
 * The Wall at TV geometry with the editor's chrome on top. It is the real
 * renderer (`WallCanvas` in an exact 1920×1080 box, scaled by a transform) and
 * the real breakpoints (`wall-root` is the `wall` query container). The chrome
 * counter-scales and is drawn only over the widget being pointed at, because
 * seven full-size toolbars would cover the picture. Everything the canvas
 * draws is `pointer-events-none` and `aria-hidden`: the track is the one
 * selection target and carries the name.
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
  onMove,
  onMeasure,
  className,
}: WallPreviewProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [dropping, setDropping] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  // ResizeObserver where there is one (the pane changes width when the
  // settings pane opens, not only the window); a frame not yet laid out draws
  // at natural size rather than dividing by zero.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const width = frame.getBoundingClientRect().width;
      setScale(width > 0 ? width / WALL_TV_WIDTH : 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // Measured at the canvas's own 1920×1080, before the transform; the box is
  // a `wall` query container, so the height is the television's at every
  // screen width.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !onMeasure) return;
    onMeasure(box.scrollHeight);
  }, [layout, data, meetings, calendarState, nowMs, scale, onMeasure]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>, rowId: string, index: number) => {
      const widgetId = event.dataTransfer?.getData(WALL_DRAG_TYPE);
      setDropping(null);
      if (!widgetId) return;
      event.preventDefault();
      // Left half means before this widget, right half after it: the only
      // reading that can express "put it last".
      const rect = event.currentTarget.getBoundingClientRect();
      const after = rect.width > 0 && event.clientX - rect.left > rect.width / 2;
      onMove(widgetId, rowId, after ? index + 1 : index);
    },
    [onMove],
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        ref={frameRef}
        // A transform does not change layout, so the frame reserves the
        // scaled box's height itself.
        style={{ height: `${WALL_TV_HEIGHT * scale}px` }}
        className="w-full overflow-hidden border border-border bg-background"
        // The TV never draws light, but this box sits inside the desk's
        // `.light`; `data-theme="dark"` re-declares the dark tokens here.
        data-theme="dark"
        data-wall-preview
        data-wall-preview-scale={scale.toFixed(3)}
      >
        <div
          ref={boxRef}
          // `wall-root` is the television's scope and the `wall` query
          // container, as `WallRoute` puts it above the canvas. The padding is
          // the TV route's own, resolved: a container cannot query itself, and
          // this box is 1920 wide on every screen.
          className="wall-root flex flex-col bg-background px-wall-inset-x py-wall-inset-y"
          style={
            {
              width: `${WALL_TV_WIDTH}px`,
              height: `${WALL_TV_HEIGHT}px`,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              // Read by the chrome, so a control keeps its real size.
              "--wall-chrome-scale": scale > 0 ? 1 / scale : 1,
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
            editing={({ widget, row, rowIndex, column, index, node }) => {
              const spec = WALL_WIDGET_LIBRARY[widget.type];
              const selected = widget.id === selectedId;
              // One toolbar at a time, over the widget being pointed at.
              const chrome =
                scale >= CHROME_MIN_SCALE && (selected || hovered === widget.id);
              return (
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={`${spec.label}, widget ${index + 1} of ${column ? "column " : ""}row ${rowIndex + 1}`}
                  data-wall-edit-widget={widget.id}
                  data-selected={selected ? "" : undefined}
                  data-dropping={dropping === widget.id ? "" : undefined}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(WALL_DRAG_TYPE, widget.id);
                    event.dataTransfer.effectAllowed = "move";
                    onSelect(widget.id);
                  }}
                  onDragEnd={() => setDropping(null)}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(WALL_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropping(widget.id);
                  }}
                  onDragLeave={() => setDropping((id) => (id === widget.id ? null : id))}
                  onDrop={(event) => handleDrop(event, row.id, index)}
                  onMouseEnter={() => setHovered(widget.id)}
                  onMouseLeave={() => setHovered((id) => (id === widget.id ? null : id))}
                  onFocus={() => setHovered(widget.id)}
                  onBlur={() => setHovered((id) => (id === widget.id ? null : id))}
                  onClick={() => onSelect(widget.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onSelect(widget.id);
                  }}
                  className={cn(
                    "relative min-w-0 cursor-grab outline-none ring-inset",
                    "ring-1 ring-border/60 hover:ring-foreground/50",
                    selected && "ring-2 ring-ring",
                    dropping === widget.id && "ring-2 ring-foreground",
                  )}
                >
                  <div className="pointer-events-none h-full" aria-hidden>
                    {node}
                  </div>
                  {chrome ? (
                    <div
                      style={{
                        transform: "scale(var(--wall-chrome-scale, 1))",
                        transformOrigin: "top left",
                      }}
                      className="absolute left-0 top-0 flex items-center gap-0.5 bg-card/95 p-0.5"
                      data-wall-edit-chrome
                    >
                      <span
                        className="grid size-9 place-items-center text-muted-foreground"
                        aria-hidden
                        title={`Drag to move ${spec.label}`}
                      >
                        <GripVertical className="size-4" />
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${spec.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemove(widget.id);
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            }}
          />
        </div>
      </div>
      <p className="text-xs tabular-nums text-muted-foreground" data-wall-preview-note>
        TV · {WALL_TV_WIDTH}×{WALL_TV_HEIGHT}, scaled to fit
      </p>
    </div>
  );
}
