import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * On a phone, a page's filters and sort are one press: below `sm` the
 * controls wait behind one "Filters" button carrying how many are narrowing
 * the page; from `sm` up the button is not drawn. What the page says about its
 * narrowing ("2 of 8 open", Clear) stays outside the fold. A period is not a
 * filter: it changes what every number means, so it stays in view.
 *
 * Two shapes. `FilterBar` is the usual one — button and controls in one row,
 * with an `aside` that stays visible beside the button (a freshness badge).
 * `FilterFold` + `FilterToggle` + `FilterControls` is for a page whose button
 * shares a row with something else (Sites puts it beside its range).
 */

interface FoldState {
  open: boolean;
  toggle: () => void;
  id: string;
  active: number;
  label: string;
}

const FoldContext = createContext<FoldState | null>(null);

function useFold(): FoldState {
  const fold = useContext(FoldContext);
  if (!fold) throw new Error("FilterToggle and FilterControls sit inside a FilterFold");
  return fold;
}

export interface FilterFoldProps {
  /** How many controls are narrowing the page now (not at their default). The
   * button carries it, so a folded page never hides that it is filtered. */
  active: number;
  /** The button's word. "Filters" unless the fold also holds the sort. */
  label?: string;
  children: ReactNode;
}

/** The state a toggle and its controls share. Draws nothing of its own. */
export function FilterFold({ active, label = "Filters", children }: FilterFoldProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <FoldContext.Provider value={{ open, toggle: () => setOpen((current) => !current), id, active, label }}>
      {children}
    </FoldContext.Provider>
  );
}

/** The one press, on a phone only: its word, and the count when it is not zero. */
export function FilterToggle({ className }: { className?: string }) {
  const { open, toggle, id, active, label } = useFold();
  return (
    <Button
      type="button"
      variant="outline"
      className={cn("w-fit sm:hidden", open && "bg-muted", className)}
      aria-expanded={open}
      aria-controls={id}
      // The badge is a bare digit; the name says what it counts.
      aria-label={active > 0 ? `${label}, ${active} on` : undefined}
      onClick={toggle}
      data-filter-toggle
      data-filter-count={active}
    >
      <SlidersHorizontal aria-hidden />
      {label}
      {active > 0 ? (
        <span aria-hidden className="rounded-full bg-foreground px-1.5 text-[11px] font-semibold tabular-nums leading-5 text-background">
          {active}
        </span>
      ) : null}
    </Button>
  );
}

export interface FilterControlsProps {
  children: ReactNode;
  /** The row the controls lay out in — the page's own classes, unchanged on a desk. */
  className?: string;
  /** `data-*` marks the page's tests and audits already select the row by. */
  marks?: Record<`data-${string}`, string>;
}

/** The controls: folded on a phone until the toggle opens them, always in place from `sm` up. */
export function FilterControls({ children, className, marks }: FilterControlsProps) {
  const { open, id } = useFold();
  return (
    <div id={id} className={cn(className, !open && "max-sm:hidden")} data-filter-controls={open ? "open" : "folded"} {...marks}>
      {children}
    </div>
  );
}

export interface FilterBarProps extends FilterFoldProps {
  /** The row's classes; on a desk the controls lay out in it. */
  className?: string;
  /** Beside the button on a phone and after the controls on a desk, never
   * folded: a fact about the list (its freshness, where in an archive). */
  aside?: ReactNode;
  marks?: Record<`data-${string}`, string>;
}

/**
 * The usual shape: one row. On a phone it is the button (and `aside`), and the
 * controls open under it; on a desk it is the page's own row of controls.
 */
export function FilterBar({ active, label, children, className, aside, marks }: FilterBarProps) {
  return (
    <FilterFold active={active} label={label}>
      <div className={cn(className, "max-sm:flex-wrap")} data-filter-bar {...marks}>
        <FilterToggle />
        <FilterRow>{children}</FilterRow>
        {/* Placed by the page: a node that should sit at the row's end
            carries its own `ms-auto`. */}
        {aside}
      </div>
    </FilterFold>
  );
}

/** Inside `FilterBar` the controls join the row itself (`contents`), so a desk
 * lays them out as the page's own flex items. */
function FilterRow({ children }: { children: ReactNode }) {
  const { open, id } = useFold();
  return (
    <div id={id} className={cn("contents", !open && "max-sm:hidden")} data-filter-controls={open ? "open" : "folded"}>
      {children}
    </div>
  );
}
