import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

/** One tab. The active tab is a location, not component state, so a tab can
 * be linked to, bookmarked, and reached with Back. */
export interface TabSpec {
  key: string;
  /** Where the tab goes. It may carry a query string (filters handed across
   * the switch), because only the path decides which tab is selected. Two
   * tabs may therefore never differ by query alone: both would light. */
  to: string;
  label: string;
  /** Exact-match this path. The index tab needs it, or it matches every tab. */
  end?: boolean;
  /** A number the tab carries. */
  count?: number;
  /** A small state glyph seated before the count. */
  glyph?: ReactNode;
  /** Hover/tap explainer for what the count or glyph means. */
  title?: string;
  /** Called when a pointer rests on the tab or the keyboard focuses it, the
   * moment before it is opened; the asset page fetches the tab's code here. */
  onIntent?: () => void;
}

/** The DOM id of one tab, so its panel can name it in `aria-labelledby`. */
export function tabId(idBase: string, key: string): string {
  return `${idBase}-${key}`;
}

export interface TabsProps {
  /** What this set of tabs navigates — the tablist's accessible name. */
  label: string;
  tabs: TabSpec[];
  /** Prefix for each tab's DOM id; pair it with the same value on `TabPanel`. */
  idBase: string;
  /** The panel every tab controls (one panel, swapped by the router). */
  panelId: string;
  className?: string;
}

/** Trailing slashes are the one difference a URL comparison must not see. */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The place half of a tab's `to`. Matching on the path is what `NavLink`
 * itself does with a `to` that has a search, so the tab's selection and the
 * link's `aria-current` tell the same story. */
function pathOf(to: string): string {
  const cut = to.search(/[?#]/);
  return cut === -1 ? to : to.slice(0, cut);
}

export function isTabActive(pathname: string, to: string, end = false): boolean {
  const here = normalize(pathname);
  const there = normalize(pathOf(to));
  return end ? here === there : here === there || here.startsWith(`${there}/`);
}

/**
 * The desk's tab bar: an ARIA tablist whose tabs are links, so selection
 * survives a reload, a bookmark and Back. Selection is decided by the path,
 * so a link may carry a query. Manual activation (WAI-ARIA APG): arrow keys
 * and Home/End move focus, Enter or Space opens, because panels mount charts
 * and tables.
 */
export function Tabs({ label, tabs, idBase, panelId, className }: TabsProps) {
  const { pathname } = useLocation();
  const list = useRef<HTMLDivElement | null>(null);

  // The scroll below must re-run when a count changes, not only the route:
  // counts arrive a beat after first paint and move every tab to their right.
  const measure = tabs.map((tab) => `${tab.key}:${tab.count ?? ""}`).join("|");

  // Brings the selected tab into the scrolling strip. The strip's own
  // `scrollLeft`, not `scrollIntoView`: that also scrolls every ancestor, so
  // selecting a tab would jump the page.
  useEffect(() => {
    const strip = list.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !selected) return;
    const right = selected.offsetLeft + selected.offsetWidth;
    if (selected.offsetLeft < strip.scrollLeft) strip.scrollLeft = selected.offsetLeft;
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [pathname, measure]);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const items = [
      ...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ];
    if (items.length === 0) return;
    const focused = items.indexOf(document.activeElement as HTMLElement);
    const from =
      focused === -1
        ? Math.max(
            0,
            items.findIndex((el) => el.getAttribute("aria-selected") === "true"),
          )
        : focused;
    const next =
      event.key === "ArrowRight"
        ? (from + 1) % items.length
        : event.key === "ArrowLeft"
          ? (from - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : items.length - 1;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    // The strip scrolls, the page does not. The divider is on the wrapper so
    // the scroller cannot clip it, and the strip is pulled a pixel down over
    // it so the selected tab's border lands on the line.
    <div className={cn("-mx-1 border-b border-border px-1", className)} data-tab-strip>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        onKeyDown={move}
        className="-mb-px flex items-center gap-1 overflow-x-auto overscroll-x-contain"
      >
        {tabs.map((tab) => {
          const selected = isTabActive(pathname, tab.to, tab.end);
          return (
            <NavLink
              key={tab.key}
              id={tabId(idBase, tab.key)}
              to={tab.to}
              end={tab.end}
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              title={tab.title}
              onPointerEnter={tab.onIntent}
              onFocus={tab.onIntent}
              onKeyDown={(event) => {
                // An anchor opens on Enter by itself; Space is the other half of
                // the APG contract and does nothing on a link without this.
                if (event.key === " ") {
                  event.preventDefault();
                  event.currentTarget.click();
                }
              }}
              // `ui/pill.ts`'s control contract (focus ring, thumb floor) but
              // not its box: a tab is an underline on a divider, not a pill.
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-sm",
                pillControlClass,
                selected
                  ? "border-primary font-medium text-primary"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.glyph}
              {tab.count === undefined ? null : (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-xs tabular-nums",
                    selected
                      ? "bg-foreground/10 text-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {tab.count}
                </span>
              )}
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}

export interface TabPanelProps {
  /** Must equal the `panelId` given to `Tabs`. */
  id: string;
  /** Same `idBase` as `Tabs`, plus the active tab's key: the panel says which
   * tab names it, which is what makes the pair a tablist rather than a row of
   * links. */
  idBase: string;
  activeKey: string;
  className?: string;
  children: ReactNode;
}

/** The one panel the tab bar swaps. Only the active tab's content is mounted. */
export function TabPanel({
  id,
  idBase,
  activeKey,
  className,
  children,
}: TabPanelProps) {
  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={tabId(idBase, activeKey)}
      className={cn("flex flex-col gap-4", className)}
    >
      {children}
    </div>
  );
}

export default Tabs;
