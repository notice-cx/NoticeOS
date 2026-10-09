import { ArrowDown, ArrowUp, Check, Columns2, Rows3, Trash2 } from "lucide-react";
import { Fragment, useState, type DragEvent } from "react";
import { WALL_MAX_ROWS, WALL_WIDGET_LIBRARY, isWallColumn, type WallLayout, type WallSlot, type WallWidget } from "@shared/wall-layout";
import { WALL_DRAG_TYPE } from "@/components/wall/WallPreview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** "Revenue · Needs you", "Sites · 1 column" — what a row line holds, named
 * as the library names each widget, so a row is found by what is on it (D44). */
function slotCount(slots: WallSlot[]): string {
  const columns = slots.filter(isWallColumn).length;
  const names = slots.filter((slot): slot is WallWidget => !isWallColumn(slot)).map((widget) => WALL_WIDGET_LIBRARY[widget.type]?.label ?? widget.type);
  const parts = [
    ...names,
    columns > 0 ? `${columns} column${columns === 1 ? "" : "s"}` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ") || "Empty";
}

export interface WallRowsPanelProps {
  layout: WallLayout;
  onAddRow: () => void;
  onRemoveRow: (rowId: string) => void;
  onMoveRow: (rowId: string, direction: "up" | "down") => void;
  onFillRow: (rowId: string) => void;
  /** A widget dropped on a row's line joins the end of that row. */
  onMove: (widgetId: string, toRowId: string, toIndex: number) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The Wall's rows, as rows (bead `ro-lzmq.2`).
 *
 * WHY IT IS NOT IN THE PREVIEW. The preview's editing slot wraps WIDGETS — that
 * is the whole of `WallCanvas`'s contract with the editor, and deliberately so:
 * the renderer must not learn what a row control is. Row facts therefore need a
 * surface of their own, and this is the smallest one that carries all four — the
 * order, which row stretches, adding one, and taking an empty one away.
 *
 * IT LISTS NO WIDGETS. It could, and the temptation is obvious, but then the
 * arrangement of widgets would exist twice on one screen and the operator would
 * have to work out which of the two they were changing. What it does take is a
 * DROP: an empty row draws nothing in the preview, so without a target here a
 * freshly added row could only be filled by adding a widget from the library.
 */
export function WallRowsPanel({
  layout,
  onAddRow,
  onRemoveRow,
  onMoveRow,
  onFillRow,
  onMove,
  disabled = false,
  className,
}: WallRowsPanelProps) {
  const [over, setOver] = useState<string | null>(null);

  /** A row line that takes a dropped widget at the end of that row. */
  const dropProps = (rowId: string, end: number) => ({
    "data-over": over === rowId ? "" : undefined,
    onDragOver: (event: DragEvent<HTMLLIElement>) => {
      if (disabled || !event.dataTransfer.types.includes(WALL_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(rowId);
    },
    onDragLeave: () => setOver((id) => (id === rowId ? null : id)),
    onDrop: (event: DragEvent<HTMLLIElement>) => {
      setOver(null);
      const widgetId = event.dataTransfer.getData(WALL_DRAG_TYPE);
      if (!widgetId || disabled) return;
      event.preventDefault();
      onMove(widgetId, rowId, end);
    },
  });

  return (
    <div className={cn("flex flex-col gap-2", className)} data-wall-rows>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Rows
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || layout.rows.length >= WALL_MAX_ROWS}
          onClick={onAddRow}
        >
          <Rows3 className="size-4" />
          Add a row
        </Button>
      </div>
      <ol className="flex flex-col gap-1.5">
        {layout.rows.map((row, index) => {
          const empty = row.widgets.length === 0;
          return (
            <Fragment key={row.id}>
            <li
              data-wall-row-line={row.id}
              {...dropProps(row.id, row.widgets.length)}
              className={cn(
                "flex flex-wrap items-center gap-x-2 gap-y-1.5 border border-border bg-card p-2",
                over === row.id && "border-foreground",
              )}
            >
              <span className="text-sm font-medium text-foreground">Row {index + 1}</span>
              <span className="text-xs text-muted-foreground">
                {empty ? "empty — drop a widget here" : slotCount(row.widgets)}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  type="button"
                  variant={row.height === "fill" ? "default" : "outline"}
                  size="sm"
                  aria-pressed={row.height === "fill"}
                  disabled={disabled}
                  onClick={() => onFillRow(row.id)}
                >
                  {/* The pressed state is a MARK as well as a fill: doc 14
                      refuses a state carried by tone alone, and one row of
                      four looking slightly darker than the rest is exactly the
                      difference nobody sees. */}
                  {row.height === "fill" ? <Check className="size-4" /> : null}
                  Remaining height
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Move row ${index + 1} up`}
                  disabled={disabled || index === 0}
                  onClick={() => onMoveRow(row.id, "up")}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Move row ${index + 1} down`}
                  disabled={disabled || index === layout.rows.length - 1}
                  onClick={() => onMoveRow(row.id, "down")}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove row ${index + 1}`}
                  // An empty row only: a control labelled "remove row" that also
                  // deleted three widgets would be deleting something its label
                  // never mentioned.
                  title={empty ? undefined : "Move its widgets out first."}
                  disabled={disabled || !empty}
                  onClick={() => onRemoveRow(row.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
            {/* A column's rows, under the row that holds it (bead
                `ro-trai.2`): a drop joins that column row, and one of them
                can take the column's remaining height. An emptied column row
                goes by itself, so there is nothing to remove here. */}
            {row.widgets.filter(isWallColumn).flatMap((column) =>
              column.rows.map((inner, innerIndex) => (
                <li
                  key={inner.id}
                  data-wall-column-row-line={inner.id}
                  {...dropProps(inner.id, inner.widgets.length)}
                  className={cn(
                    "ml-6 flex flex-wrap items-center gap-x-2 gap-y-1.5 border border-dashed border-border bg-card p-2",
                    over === inner.id && "border-foreground",
                  )}
                >
                  <Columns2 className="size-4 text-muted-foreground" aria-hidden />
                  <span className="text-sm font-medium text-foreground">Column row {innerIndex + 1}</span>
                  <span className="text-xs text-muted-foreground">
                    {slotCount(inner.widgets)}
                  </span>
                  <Button
                    type="button"
                    variant={inner.height === "fill" ? "default" : "outline"}
                    size="sm"
                    className="ml-auto"
                    aria-pressed={inner.height === "fill"}
                    disabled={disabled}
                    onClick={() => onFillRow(inner.id)}
                  >
                    {inner.height === "fill" ? <Check className="size-4" /> : null}
                    Remaining height
                  </Button>
                </li>
              )),
            )}
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}
