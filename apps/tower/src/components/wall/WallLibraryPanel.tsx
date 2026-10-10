import { Check, Plus } from "lucide-react";
import type { WallLayout, WallWidgetType } from "@shared/wall-layout";
import { Button } from "@/components/ui/button";
import { WALL_WIDGET_PLACED, wallLibraryOptions } from "@/lib/wall-editor";
import { cn } from "@/lib/utils";

export interface WallLibraryPanelProps {
  layout: WallLayout;
  onAdd: (type: WallWidgetType) => void;
  /** A deployment that cannot save still shows the library, but nothing in it
   * is offered. */
  disabled?: boolean;
  className?: string;
}

/**
 * The fixed widget library. Every type the contract knows is listed, including
 * the ones already placed, so the list answers "what can this TV show" the
 * same way whatever it shows now; a refused Add becomes its state on the row
 * ("On the TV" or "TV full").
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
              {/* A refused Add is a state in the button's place, never a
                  sentence under the row. */}
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
            {/* What is on the widget, as facets — never a sentence. */}
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
