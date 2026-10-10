import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

/** One tab. `key` is the stable slug the panel points back at; `to` is the URL
 * the tab IS — the active tab is a location, not component state, so a tab can
 * be linked to, bookmarked, and reached with Back. */
export interface TabSpec {
  key: string;
  /** Where the tab goes. It may carry a query string — filters the operator has
   * already set, handed across the switch — because only the PATH decides which
   * tab is selected. A tab is a place; the query is that place's view state. Two
   * tabs may therefore never differ by query alone: both would light. */
  to: string;
  label: string;
  /** Exact-match this path. The index tab needs it, or it matches every tab. */
  end?: boolean;
  /** A number the tab carries — open alerts, open outcome checks. */
  count?: number;
  /** A small state glyph seated before the count (a severity dot, a segmented
   * ratio bar). doc 14: a tab with state answers with a shape, not a word. */
  glyph?: ReactNode;
  /** Hover/tap explainer for what the count or glyph means (doc 14 principle 9). */
  title?: string;
  /** Called when a pointer rests on the tab or the keyboard focuses it — the
   * moment before it is opened. The asset page fetches that tab's code here
   * (bead `ro-ujb9.84`), the way the sidebar does for a page's. */
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

/** The place half of a tab's `to`, dropping any query string or hash it carries
 * across the switch (bead `ro-clz8`). Matching on the path is what `NavLink`
 * itself does with a `to` that has a search, so this keeps the tab's own
 * selection and the link's `aria-current` telling the same story. */
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
 * The desk's tab bar: an ARIA tablist whose tabs are links (bead `ro-pbzu.4`).
 *
 * The registry had no tab primitive, and the asset page had grown the thing tabs
 * exist to replace — one very long scroll with collapsed question disclosures and
 * a sticky "Jump to" navigator, which told a stranger nothing about where they
 * were and needed a deep link to open a `<details>` programmatically before it
 * could scroll (the 2026-07 audit's finding 11).
 *
 * Two decisions worth keeping:
 *
 * **The tab is the URL.** Each tab is a `NavLink`, so selection survives a
 * reload, a bookmark, and Back, and one hash→tab map is all a deep link needs.
 *
 * **Selection is decided by the PATH, so a link may carry a query** (bead
 * `ro-clz8`). Alerts narrowed to one asset stays narrowed across Open ↔ History
 * because each tab links with the filters the destination can honour; the query
 * is stripped before the comparison, so the tab still lights. The constraint
 * that buys: two tabs must never differ by query string alone.
 *
 * **Manual activation** (WAI-ARIA APG). Arrow keys and Home/End move focus along
 * the bar; Enter or Space opens the focused tab. Panels here mount charts and
 * tables, so activating on every arrow press would render five panels on the way
 * to the sixth.
 */
export function Tabs({ label, tabs, idBase, panelId, className }: TabsProps) {
  const { pathname } = useLocation();
  const list = useRef<HTMLDivElement | null>(null);

  /**
   * What each tab CURRENTLY measures, near enough — its key and whatever number
   * it is wearing. The scroll below has to re-run when this changes, not only
   * when the route does: the counts arrive with the payload, a beat after first
   * paint, and every tab to the right of one that gained a badge moves. Keyed on
   * the route alone, the strip settles against widths that are already stale and
   * leaves the selected tab half off the edge.
   */
  const measure = tabs.map((tab) => `${tab.key}:${tab.count ?? ""}`).join("|");

  // The strip scrolls, so the selected tab has to be brought into it. Seven
  // asset tabs do not fit 390px and Settings is the seventh: without this, a
  // deep link to a tab off the right edge lands on a bar showing Overview with
  // nothing lit (bead `ro-md80`).
  //
  // The strip's own `scrollLeft`, not `scrollIntoView`: that method also scrolls
  // every ancestor, so selecting a tab would jump the PAGE — the exact thing the
  // asset page's hash→tab map exists to control — and it is what the deep-link
  // tests watch. A bar that already fits (every desk width) moves not at all.
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
    // THE STRIP SCROLLS, THE PAGE DOES NOT (bead `ro-md80`). The bar used to
    // wrap, which fits — but a wrapped tablist draws the selected tab's
    // underline in mid-air two rows above the divider it belongs to, and the
    // asset page's seven tabs became three ragged rows of chrome above the
    // content on a phone. One line that scrolls inside its own box is the
    // idiom every touch product uses for exactly this, and it never touches
    // the page's own width. The divider is on the WRAPPER so the scroller
    // cannot clip it, and the strip is pulled a pixel down over it so the
    // selected tab's border lands on the line rather than above it.
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
              // The control contract — focus ring and the phone thumb floor a
              // 36px tab is under (bead `ro-md80`) — is `ui/pill.ts`'s, shared
              // with five hand-rolled toggles that are not `<Button>` either
              // (bead `ro-s4rg`). The BOX is not: a tab is an underline on a
              // divider, not a pill, and reading a bordered box here only to
              // cancel its border and its radius would be worse than the
              // literal. Selected underlines rather than fills, for the same
              // reason.
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

/** The one panel the tab bar swaps. Only the active tab's content is mounted —
 * which is the other half of what tabs bought: five sections of charts no longer
 * render to answer a question nobody asked. */
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
