import { draggable } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { Check, ChevronDown, GripVertical, LayoutTemplate, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sameWallLayout, type WallLayout, type WallWidgetSpec, type WallWidgetType } from "@shared/wall-layout";
import { wallDragData, wallDragPreview } from "@/components/wall/WallPreview";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { focusFirstMenuItem, roveMenuFocus } from "@/lib/menu-keys";
import { WALL_WIDGET_PLACED, wallLibraryOptions, wallPresetOptions } from "@/lib/wall-editor";
import { cn } from "@/lib/utils";

export interface WallLibraryPanelProps {
  layout: WallLayout;
  onAdd: (type: WallWidgetType) => void;
  /** Replace the whole arrangement with a Wall preset; absent offers no
   * Start from. */
  onStart?: (layout: WallLayout, label: string) => void;
  /** Close the drawer; absent where the library is always shown. */
  onClose?: () => void;
  /** A deployment that cannot save still shows the library, but nothing in it
   * is offered. */
  disabled?: boolean;
  className?: string;
}

/**
 * The Add drawer: every widget the TV can draw, including the ones already
 * placed, so the list answers "what can this TV show" the same way whatever
 * it shows now. An offered widget is dragged onto the TV, where its landing
 * line shows where it goes, or added with one press to the spot that suits
 * it; a refused one shows why in the button's place ("On the TV" or "TV
 * full"). Start from replaces the whole arrangement with a Wall preset,
 * one step Undo takes back.
 */
export function WallLibraryPanel({
  layout,
  onAdd,
  onStart,
  onClose,
  disabled = false,
  className,
}: WallLibraryPanelProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} data-wall-library id="wall-add-drawer">
      <div className="flex items-center gap-2">
        <h2 className="me-auto text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Add a widget
        </h2>
        {onStart ? <StartFrom layout={layout} disabled={disabled} onStart={onStart} /> : null}
        {onClose ? (
          <Button type="button" variant="ghost" size="icon" aria-label="Close Add a widget" onClick={onClose}>
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1.5">
        {wallLibraryOptions(layout).map(({ spec, disabledReason }) => (
          <LibraryItem
            key={spec.type}
            spec={spec}
            refusal={disabledReason}
            disabled={disabled}
            onAdd={() => onAdd(spec.type)}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Start from: each independent Wall preset as one menu item.
 * The one the TV already shows is checked and not offered.
 */
function StartFrom({
  layout,
  disabled,
  onStart,
}: {
  layout: WallLayout;
  disabled: boolean;
  onStart: (layout: WallLayout, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-haspopup="menu" disabled={disabled} data-wall-start-from="">
          <LayoutTemplate className="size-4" />
          Start from
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label="Start from"
        align="end"
        className="w-60 p-1.5"
        onKeyDown={roveMenuFocus}
        onOpenAutoFocus={focusFirstMenuItem}
        data-wall-start-menu=""
      >
        {wallPresetOptions().map((option) => {
          const current = sameWallLayout(option.layout, layout);
          return (
            <button
              key={option.view}
              type="button"
              role="menuitem"
              disabled={current}
              aria-current={current ? "true" : undefined}
              data-wall-preset={option.view}
              onClick={() => {
                setOpen(false);
                onStart(option.layout, option.label);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground outline-none",
                "hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:text-muted-foreground max-sm:min-h-11",
              )}
            >
              <span className="flex-1">{option.label}</span>
              {current ? <Check className="size-4 shrink-0" aria-label="On the TV" /> : null}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function LibraryItem({
  spec,
  refusal,
  disabled,
  onAdd,
}: {
  spec: WallWidgetSpec;
  refusal: string | null;
  disabled: boolean;
  onAdd: () => void;
}) {
  const ref = useRef<HTMLLIElement | null>(null);
  const offered = refusal === null && !disabled;

  useEffect(() => {
    const element = ref.current;
    if (!element || !offered) return;
    return draggable({
      element,
      getInitialData: () => wallDragData({ kind: "new", widget: spec.type }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => wallDragPreview(spec.type, nativeSetDragImage),
    });
  }, [offered, spec.type]);

  return (
    <li
      ref={ref}
      data-wall-library-item={spec.type}
      className={cn(
        "flex flex-col gap-1 border border-border bg-card p-2.5",
        offered && "cursor-grab hover:border-foreground/40 active:cursor-grabbing",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
          {offered ? <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
          {spec.label}
        </span>
        {/* A refused Add is a state in the button's place, never a sentence
            under the row. */}
        {refusal ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
            data-wall-library-refusal={refusal}
          >
            {refusal === WALL_WIDGET_PLACED ? <Check className="size-3.5" aria-hidden /> : null}
            {refusal}
          </span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={disabled}
            aria-label={`Add ${spec.label}`}
            onClick={onAdd}
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
  );
}
