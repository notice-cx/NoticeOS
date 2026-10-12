import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpToLine,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Move,
  Rows2,
  Trash2,
} from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { WALL_WIDGET_LIBRARY, type WallLayout } from "@shared/wall-layout";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { wallMovePlan, wallStackChoices, type WallMove } from "@/lib/wall-editor";

export interface WallMoveMenuProps {
  layout: WallLayout;
  widgetId: string;
  onMove: (move: WallMove) => void;
  onRemove: () => void;
  disabled?: boolean;
  /** `chrome`: an icon on the widget's own toolbar. `panel`: a labelled
   * button in the widget's settings, where a phone or a keyboard finds it. */
  variant?: "chrome" | "panel";
}

const STEPS: { move: Exclude<WallMove, object>; label: string; keys?: string; icon: ReactNode }[] = [
  { move: "up", label: "Move up", keys: "Alt ↑", icon: <ArrowUp /> },
  { move: "down", label: "Move down", keys: "Alt ↓", icon: <ArrowDown /> },
  { move: "left", label: "Move left", keys: "Alt ←", icon: <ArrowLeft /> },
  { move: "right", label: "Move right", keys: "Alt →", icon: <ArrowRight /> },
];

const OUT: { move: Exclude<WallMove, object>; label: string; icon: ReactNode }[] = [
  { move: "own-column", label: "Into its own column", icon: <Columns2 /> },
  { move: "row-above", label: "Into a new row above", icon: <ArrowUpToLine /> },
  { move: "row-below", label: "Into a new row below", icon: <ArrowDownToLine /> },
];

/** Move focus among a menu's enabled items with the arrow keys, Home and End. */
function roveFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

/**
 * Every place a drag can put a widget, as a menu: for a keyboard, a tap, or
 * anyone who would rather pick than drag (WCAG 2.5.7). Up and down step
 * through its column and then out into a row of its own; left and right step
 * to the neighbouring column; "Stack under" names any other widget; the rest
 * take it out on its own. An item that would not move it is disabled, so the
 * menu is also an honest picture of where it can go.
 */
export function WallMoveMenu({
  layout,
  widgetId,
  onMove,
  onRemove,
  disabled = false,
  variant = "chrome",
}: WallMoveMenuProps) {
  const [open, setOpen] = useState(false);
  const [stacking, setStacking] = useState(false);
  const widget = layout.rows
    .flatMap((row) => row.widgets.flatMap((slot) => (slot.type === "column" ? slot.rows.flatMap((r) => r.widgets) : [slot])))
    .find((w) => w.id === widgetId);
  if (!widget) return null;
  const label = WALL_WIDGET_LIBRARY[widget.type].label;
  const can = (move: WallMove) => wallMovePlan(layout, widgetId, move) !== null;
  const choices = stacking ? wallStackChoices(layout, widgetId) : [];

  const choose = (move: WallMove) => {
    setOpen(false);
    setStacking(false);
    onMove(move);
  };

  const item = (key: string, content: ReactNode, onSelect: () => void, enabled = true, extra?: string) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      disabled={!enabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground outline-none",
        "hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground max-sm:min-h-11",
        extra,
      )}
    >
      {content}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setStacking(false);
      }}
    >
      <PopoverTrigger asChild>
        {variant === "chrome" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move ${label}`}
            aria-haspopup="menu"
            disabled={disabled}
            // The press also selects the widget (it bubbles to its frame), so
            // its toolbar stays drawn while focus is in the menu.
            data-wall-move-trigger={widgetId}
          >
            <Move className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-haspopup="menu"
            disabled={disabled}
            data-wall-move-trigger={widgetId}
          >
            <Move className="size-4" />
            Move {label}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label={`Move ${label}`}
        className="w-64 p-1.5"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={roveFocus}
        onOpenAutoFocus={(event) => {
          // The first item that can act, rather than the panel itself.
          event.preventDefault();
          const panel = event.currentTarget as HTMLElement | null;
          panel?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
        }}
        data-wall-move-menu={widgetId}
      >
        {stacking ? (
          <>
            {item("back", <><ChevronLeft />Stack {label} under…</>, () => setStacking(false), true, "font-medium")}
            <div className="my-1 h-px bg-border" aria-hidden />
            {choices.length === 0
              ? <p className="px-2 py-1.5 text-sm text-muted-foreground">Nowhere to stack it</p>
              : choices.map((other) =>
                item(other.id, <><Rows2 />Under {WALL_WIDGET_LIBRARY[other.type].label}</>, () => choose({ under: other.id })))}
          </>
        ) : (
          <>
            {STEPS.map(({ move, label: text, keys, icon }) =>
              item(move, <>{icon}<span className="flex-1">{text}</span>{keys ? <kbd className="font-sans text-xs text-muted-foreground">{keys}</kbd> : null}</>, () => choose(move), can(move)))}
            <div className="my-1 h-px bg-border" aria-hidden />
            {item(
              "stack",
              <><Rows2 /><span className="flex-1">Stack under…</span><ChevronRight /></>,
              () => {
                setStacking(true);
                // The list replaces this one; its first entry takes focus.
                requestAnimationFrame(() =>
                  document.querySelector<HTMLButtonElement>(`[data-wall-move-menu="${widgetId}"] [role="menuitem"]:not([disabled])`)?.focus(),
                );
              },
              wallStackChoices(layout, widgetId).length > 0,
            )}
            {OUT.map(({ move, label: text, icon }) => item(move, <>{icon}{text}</>, () => choose(move), can(move)))}
            <div className="my-1 h-px bg-border" aria-hidden />
            {item("remove", <><Trash2 />Remove {label}</>, () => {
              setOpen(false);
              onRemove();
            })}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
