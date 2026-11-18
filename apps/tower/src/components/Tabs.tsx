import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { NavLink, useLocation, useNavigate, useNavigationType } from "react-router-dom";
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
  retainKeyboardFocus?: boolean;
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

function revealTab(strip: HTMLElement, tab: HTMLElement) {
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  if (left < strip.scrollLeft) strip.scrollLeft = left;
  else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
}

/**
 * The desk's tab bar: an ARIA tablist whose tabs are links, so selection
 * survives a reload, a bookmark and Back. Selection is decided by the path,
 * so a link may carry a query. Manual activation (WAI-ARIA APG): arrow keys
 * and Home/End move focus, Enter or Space opens, because panels mount charts
 * and tables.
 */
export function Tabs({ label, tabs, idBase, panelId, retainKeyboardFocus = false, className }: TabsProps) {
  const { pathname, key, state } = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const list = useRef<HTMLDivElement | null>(null);
  const revealedPath = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!retainKeyboardFocus || navigationType !== "PUSH" || document.activeElement !== document.body) return;
    const selected = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selected && state?.focusTab === selected.id) selected.focus();
  }, [key, navigationType, retainKeyboardFocus, state]);

  // The scroll below must re-run when a count changes, not only the route:
  // counts arrive a beat after first paint and move every tab to their right.
  const measure = tabs.map((tab) => `${tab.key}:${tab.count ?? ""}`).join("|");

  // Count updates can shift tabs while keyboard focus is on an unselected tab.
  // Reveal selection on navigation and preserve focus during count updates.
  useEffect(() => {
    const strip = list.current;
    if (!strip) return;
    const focused = revealedPath.current === pathname ? strip.querySelector<HTMLElement>('[role="tab"]:focus') : null;
    const tab = focused ?? strip.querySelector<HTMLElement>('[aria-selected="true"]');
    revealedPath.current = pathname;
    if (tab) revealTab(strip, tab);
  }, [pathname, measure]);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const strip = list.current;
    if (!strip) return;
    const items = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
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
    const tab = items[next];
    if (tab) {
      tab.focus({ preventScroll: true });
      revealTab(strip, tab);
    }
  }

  return (
    <div className={cn("min-w-0 border-b border-border", className)} data-tab-strip>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        onKeyDown={move}
        // The positioned scroller is the offset parent for revealTab.
        className="relative flex min-w-0 items-stretch gap-1 overflow-x-auto overscroll-x-contain"
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
                if (retainKeyboardFocus && !selected && (event.key === "Enter" || event.key === " ")
                  && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                  event.preventDefault();
                  void navigate(tab.to, { state: { focusTab: tabId(idBase, tab.key) } });
                  return;
                }
                // An anchor opens on Enter by itself; Space is the other half of
                // the APG contract and does nothing on a link without this.
                if (event.key === " ") {
                  event.preventDefault();
                  event.currentTarget.click();
                }
              }}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-base font-semibold outline-none sm:min-h-12 sm:px-4",
                "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-4 focus-visible:outline-ring",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.glyph}
              {tab.count === undefined ? null : (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-xs tabular-nums",
                    selected
                      ? "bg-muted text-foreground"
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
      // `page-arrive`: a tab's content fades in when it replaces the last.
      className={cn("page-arrive flex flex-col gap-4", className)}
    >
      {children}
    </div>
  );
}

export default Tabs;
