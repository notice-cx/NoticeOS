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
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What a drag is carrying. Native drag-and-drop moves a string, and this is
 * the string: no library, no drag state in a store, and a drop from anywhere
 * else in the browser carries something this does not recognize and is ignored. */
export const WALL_DRAG_TYPE = "application/x-noticeos-wall-widget";

/**
 * Below this scale the chrome is not drawn at all.
 *
 * The chrome counter-scales, so it is the same number of SCREEN pixels however
 * far the television has been shrunk — which is right until the widget itself
 * is narrower than its own toolbar. On a phone a three-widget row gives each
 * widget about 40 screen pixels and two 36px controls are 76, so the bar would
 * cover the picture it sits on. Under this width the preview is a picture you
 * tap to select, and every action lives in the widget panel — which is also
 * where a touch operator has to work anyway, since a touch never fires a drag.
 */
const CHROME_MIN_SCALE = 0.25;

export interface WallPreviewProps {
  layout: WallLayout;
  data: WallPayload;
  meetings?: CalendarUpcoming | null;
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
  /** The measured content height of the 1920×1080 canvas, after every change —
   * the editor turns it into the fit note. */
  onMeasure?: (contentHeightPx: number) => void;
  className?: string;
}

/**
 * The Wall at TV geometry, with the editor's chrome on top (bead `ro-lzmq.2`).
 *
 * IT IS THE REAL RENDERER. The box is exactly 1920×1080 — the TV
 * `scripts/wall-fit-check.mjs` measures — scaled with a transform to whatever
 * width the pane has, and what is inside it is `WallCanvas`, the same component
 * `/wall` draws. A preview with its own layout engine is a preview that lies,
 * and this editor's entire promise is that what the operator arranges is what
 * the television shows.
 *
 * AND IT IS THE REAL BREAKPOINTS (bead `ro-lzmq.5`). The box carries
 * `wall-root`, which `index.css` declares a query container named `wall`, and
 * every breakpoint variant fires on that container as well as on the viewport.
 * So the assets grid is five across and the type is TV-sized inside this box on
 * a 390px phone, exactly as on the kiosk — which is why the fit note is now
 * stated at every width instead of withheld below `xl`.
 *
 * THE CHROME COUNTER-SCALES, AND APPEARS ONE AT A TIME. At 1440 the pane gives
 * the box about a third of its natural width, so a drag handle drawn inside the
 * transform would be four millimetres across and a 44px touch target would be
 * 15. Each widget's chrome therefore carries the inverse scale, which keeps it
 * the size the operator's finger expects at every pane width. That has a cost
 * the first capture made obvious: at full size, seven toolbars over widgets
 * about 110 screen pixels wide covered the entire television. So the toolbar is
 * drawn only over the widget the operator is already pointing at — hovered,
 * focused, or selected — and everything it holds is also in the widget panel,
 * which never hides. The ring is the affordance the rest of the time.
 *
 * THE WIDGET IS A PICTURE. Everything the canvas draws is `pointer-events-none`
 * here: the Wall's own links and buttons must not be operable through a preview,
 * and the whole track is one selection target instead. That is also why the
 * drawn widget is `aria-hidden` and the track carries the name — a screen reader
 * reading the assets grid twice, once as content and once as a thing to move,
 * would be reading the editor's furniture as the portfolio.
 */
export function WallPreview({
  layout,
  data,
  meetings,
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

  // The frame's width decides the scale. ResizeObserver where there is one (the
  // pane changes width when the settings pane opens, not only when the window
  // does); a window listener is the fallback, and a frame that has not been laid
  // out yet — jsdom, or the first paint — draws at natural size rather than
  // dividing by zero.
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

  // The fit check measures the canvas at its OWN 1920×1080, before the
  // transform — a scaled measurement would only ever say the pane is smaller
  // than the TV, which nobody needed telling. It measures at EVERY screen width
  // since bead `ro-lzmq.5`: the box is a `wall` query container, so the widgets
  // inside it draw the television's arrangement and type on a phone exactly as
  // they do on the kiosk, and the height that comes back is the television's.
  // Until that landed the reading below `xl` was the phone's own stacking and
  // the editor withheld it, because a wrong number is worse than no number.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !onMeasure) return;
    onMeasure(box.scrollHeight);
  }, [layout, data, meetings, nowMs, scale, onMeasure]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>, rowId: string, index: number) => {
      const widgetId = event.dataTransfer?.getData(WALL_DRAG_TYPE);
      setDropping(null);
      if (!widgetId) return;
      event.preventDefault();
      // Left half means before this widget, right half after it — the same
      // reading every list that can be dropped into uses, and the only one that
      // can express "put it last".
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
        // The frame reserves exactly the height the scaled box occupies: a
        // transform does not change layout, so without this the panes below
        // would sit under the television.
        style={{ height: `${WALL_TV_HEIGHT * scale}px` }}
        className="w-full overflow-hidden border border-border bg-background"
        // THE TV IS DARK ON A LIGHT DESK TOO (bead `ro-c0l3`). The television
        // never draws light (AppShell takes `.light` off `/wall`), but this box
        // sits inside the desk, whose `.light` every token below inherited: the
        // strip and the feed turned pale and the site's name faded on black.
        // `data-theme="dark"` re-declares the dark tokens here (index.css,
        // brand/notice.css), so the preview is the picture the TV shows.
        data-theme="dark"
        data-wall-preview
        data-wall-preview-scale={scale.toFixed(3)}
      >
        <div
          ref={boxRef}
          // `wall-root` is the TELEVISION'S scope — true-black canvas and cards,
          // the larger type steps — and `WallRoute` puts it on the element above
          // the canvas rather than on the canvas itself. The preview has to
          // supply the same thing, or the widgets would draw in desk tokens and
          // the preview would be showing a Wall that does not exist. It is also
          // the `wall` query container every breakpoint inside now reads
          // (`index.css`), which is what makes the widgets below draw the
          // television's arrangement on a phone.
          //
          // The padding is the TV route's own, resolved: `WallRoute` writes it
          // as `p-2 md:px-wall-inset-x md:py-wall-inset-y` (D28's frame, bead
          // `ro-trai.11`) because a Wall opened in a narrow browser window wants
          // the tighter inset, and this box is never narrow — it is 1920 on
          // every screen. A container cannot query itself, so the element that
          // IS the container is the one place the television's own values are
          // spelled out.
          className="wall-root flex flex-col bg-background px-wall-inset-x py-wall-inset-y"
          style={
            {
              width: `${WALL_TV_WIDTH}px`,
              height: `${WALL_TV_HEIGHT}px`,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              // Read by every piece of chrome below, so a control keeps its
              // real size however far the television has been shrunk to fit.
              "--wall-chrome-scale": scale > 0 ? 1 / scale : 1,
            } as CSSProperties
          }
        >
          <WallCanvas
            layout={layout}
            data={data}
            meetings={meetings}
            ga4Realtime={ga4Realtime}
            ga4RealtimeError={ga4RealtimeError}
            connections={connections}
            nowMs={nowMs}
            // The editor is never the surface that reports a failed poll — the
            // television and Home already do, and a "reconnecting" note inside
            // a preview would read as a fault in the layout being arranged.
            lastGood={false}
            editing={({ widget, row, rowIndex, column, index, node }) => {
              const spec = WALL_WIDGET_LIBRARY[widget.type];
              const selected = widget.id === selectedId;
              // ONE TOOLBAR AT A TIME, and only over a widget the operator is
              // already pointing at. The controls counter-scale to full size,
              // so seven of them at once cover the very picture the preview
              // exists to show — at desk width a widget is about 110 screen
              // pixels wide and a toolbar is 76. Hover and selection are the
              // two moments a widget is the subject; the rest of the time the
              // ring is the whole affordance, and every action is also in the
              // widget panel, which never hides.
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
      {/* A key, not an essay (bead `ro-ujb9.96.6.12`): what the box is and
          that it is scaled. */}
      <p className="text-xs tabular-nums text-muted-foreground" data-wall-preview-note>
        TV · {WALL_TV_WIDTH}×{WALL_TV_HEIGHT}, scaled to fit
      </p>
    </div>
  );
}
