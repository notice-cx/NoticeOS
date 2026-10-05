import { Check, Plus } from "lucide-react";
import type { WallLayout, WallWidgetType } from "@shared/wall-layout";
import { Button } from "@/components/ui/button";
import { WALL_WIDGET_PLACED, wallLibraryOptions } from "@/lib/wall-editor";
import { cn } from "@/lib/utils";

export interface WallLibraryPanelProps {
  layout: WallLayout;
  onAdd: (type: WallWidgetType) => void;
  /** A deployment that cannot save still shows the library — reading what the
   * Wall CAN hold is not a write — but nothing in it is offered. */
  disabled?: boolean;
  className?: string;
}

/**
 * The widget library (docs/15 flow D: the operator arranges widgets from a
 * FIXED library and never authors new types — that is a component-registry PR).
 *
 * Every type the contract knows is listed, always, including the ones already
 * on the Wall: a library that hid what was placed would answer "what can this
 * TV show" differently depending on what it currently shows, and the operator
 * would have to remove a widget to find out whether a second one was possible.
 * So a refused Add is replaced by its STATE on the row rather than hidden:
 * "On the Wall" (the preview shows where) or "Wall full".
 */
export function WallLibraryPanel({
  layout,
  onAdd,
  disabled = false,
  className,
}: WallLibraryPanelProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} data-wall-library>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Widgets
      </h2>
      <ul className="flex flex-col gap-1.5">
        {wallLibraryOptions(layout).map(({ spec, disabledReason }) => (
          <li
            key={spec.type}
            data-wall-library-item={spec.type}
            className="flex flex-col gap-1 border border-border bg-card p-2.5"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 text-sm font-medium text-foreground">{spec.label}</span>
              {/* A refused Add is a STATE in the button's place — "On the Wall"
                  with a check, or "Wall full" — never a sentence under the row
                  (bead `ro-ujb9.96.6.12`). */}
              {disabledReason ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
                  data-wall-library-refusal={disabledReason}
                >
                  {disabledReason === WALL_WIDGET_PLACED ? <Check className="size-3.5" aria-hidden /> : null}
                  {disabledReason}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={disabled}
                  aria-label={`Add ${spec.label}`}
                  onClick={() => onAdd(spec.type)}
                >
                  <Plus className="size-4" />
                  Add
                </Button>
              )}
            </div>
            {/* What is ON the widget, as facets — never a sentence (bead
                `ro-ujb9.96.6.17`); the preview shows the widget itself the
                moment it is added. */}
            <ul className="flex flex-wrap gap-x-1.5 text-xs leading-snug text-muted-foreground" data-wall-library-shows>
              {spec.shows.map((facet, index) => (
                <li key={facet} className="whitespace-nowrap">
                  {facet}
                  {/* The separator ends a line rather than starting the next. */}
                  {index < spec.shows.length - 1 ? <span aria-hidden className="ml-1.5">·</span> : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
