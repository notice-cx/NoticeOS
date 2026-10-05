import { useBrowserContext, useOwnerPreferences } from '@/lib/browser-context';
import { BrandLockup } from "@/components/BrandLockup";
import { ChevronRight, CircleSlash2, Menu, Moon, Pencil, Plus, Search, Sun, X } from "lucide-react";
import { Suspense, createContext, useContext, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { assetStatusLabel } from "@shared/asset-detail";
import {
  expiringCredentialSeverity,
  expiringCredentialSummary,
  expiringCredentials,
  type IntegrationCredentialsPayload,
} from "@shared/integrations-page";
import { sitePath } from "@shared/first-run";
import type { AssetCard } from "@shared/wall";
import { RouteLoading } from "@/components/RouteLoading";
import {
  LazyCommandPalette,
  isPaletteModifier,
  isPaletteShortcut,
  preloadCommandPalette,
} from "@/lib/palette-launch";
import {
  ASSETS_ROUTE,
  INTEGRATIONS_ROUTE,
  NAV_ITEMS,
  TV_EDIT_ITEM,
  TV_ITEM,
  type NavItem,
} from "@/components/nav-items";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { DemoViewerStatus } from '@/components/DemoViewerStatus';
import { SeverityDot } from "@/components/SeverityDot";
import { openAlertsLabel } from "@/lib/severity";
import { Button } from "@/components/ui/button";
import { useIntegrationProviders } from "@/hooks/useIntegrationProviders";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { useWall } from "@/hooks/useWall";
import { cn } from "@/lib/utils";
import { storageKey } from "@/lib/browser-storage";

// The nav list lives in its own module so `CommandPalette` — which the shell
// mounts — can read it without importing the shell back. Re-exported here
// because this is where the rest of the app has always looked for it.
export { NAV_ITEMS, TV_ITEM, PAGE_ITEMS, type NavItem } from "@/components/nav-items";

// `max-md:min-h-11`: below `md` the only sidebar in the DOM is the drawer's,
// and a 36px nav row is under the thumb target the drawer exists to serve
// (bead `ro-md80`). The desk column keeps its density.
const ITEM_BASE = "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none max-md:min-h-11 focus-visible:ring-2 focus-visible:ring-ring";
const ITEM_ACTIVE = "bg-accent-soft text-primary font-medium";
const ITEM_IDLE = "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

/** An asset row under Assets: the same shape one step in, one step quieter. */
const ASSET_ROW_BASE = "flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-2.5 text-xs outline-none max-md:min-h-11 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Above this many assets the nav shows the leading slice plus "All sites…".
 * The sidebar is a fixed list the operator scans without moving their eyes, and
 * a portfolio that scrolls the chrome has stopped being one. Twelve is a
 * CEILING rather than a live behavior — the portfolio has six — so the slice
 * exists to keep the nav honest at twenty rather than to shape it at six.
 */
const NAV_ASSET_LIMIT = 12;

/**
 * Where the sidebar remembers the asset list. Two things, one record: whether
 * the operator has it open, and how many rows it drew last time — the second is
 * what lets the first render after a reload reserve the right height instead of
 * shoving Alerts, Tasks and the rest down the column when the poll lands.
 * Namespaced exactly like the palette's own key.
 */
const NAV_ASSETS_NAME = "nav-assets";
export const NAV_ASSETS_KEY = storageKey(NAV_ASSETS_NAME);

interface NavAssetsMemory {
  /**
   * ABSENT until the operator has actually worked the chevron. The default
   * belongs to the surface (open on the desk column, closed in the drawer) and
   * writing it down as though it were a choice would leak: the desk column
   * mounts first, so the drawer would open the next time on a preference nobody
   * ever expressed.
   */
  open?: boolean;
  /** Rows drawn on the last render that had data. 0 = nothing to reserve. */
  seen: number;
}

/**
 * The remembered list state.
 *
 * Guarded like every other storage read on the desk (`useTheme`, the palette's
 * recents): a private window, a locked-down profile or JSON somebody hand-edited
 * must leave the operator with a working nav, not a blank screen. A convenience
 * that cannot be persisted is not an outage.
 */
function readNavAssets(preferences: ReturnType<typeof useOwnerPreferences>): NavAssetsMemory {
  const empty: NavAssetsMemory = { seen: 0 };
  try {
    const raw = preferences.read(NAV_ASSETS_NAME);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const record = parsed as Partial<NavAssetsMemory>;
    const seen =
      typeof record.seen === "number" && Number.isFinite(record.seen) && record.seen > 0
        ? Math.min(Math.floor(record.seen), NAV_ASSET_LIMIT)
        : 0;
    return typeof record.open === "boolean" ? { open: record.open, seen } : { seen };
  } catch {
    return empty;
  }
}

/** Merge, never replace: the count and the choice are written by different
 * events, and the two sidebars in the DOM write them at different moments. */
function patchNavAssets(preferences: ReturnType<typeof useOwnerPreferences>, patch: Partial<NavAssetsMemory>): void {
  try {
    preferences.write(
      NAV_ASSETS_NAME,
      JSON.stringify({ ...readNavAssets(preferences), ...patch }),
    );
  } catch {
    /* storage disabled or full — the list still works, it just forgets */
  }
}

/**
 * The index's default order, with retired assets sunk to the foot.
 *
 * `/assets` calls its default ordering "seed order" and implements it by NOT
 * sorting — `sort === "seed"` renders the payload as the read model built it —
 * so reusing the index's order means reusing the payload's, and there is no
 * helper to import because the default is the absence of a sort. `Array#sort`
 * is stable, so seed order survives inside each group.
 *
 * Retired sinks rather than hiding behind an "Archived (N)" disclosure: that
 * would put a second collapsible state, a second stored preference and a second
 * click into the chrome for a case the portfolio does not have yet (nothing is
 * retired today), and a retired asset is still one the operator opens — to read
 * what it earned before it was switched off. One list, one toggle, and the
 * slash glyph says which ones are done.
 */
function navAssetOrder(assets: AssetCard[]): AssetCard[] {
  const sunk = (asset: AssetCard) => (asset.status === "retired" ? 1 : 0);
  return [...assets].sort((a, b) => sunk(a) - sunk(b));
}

/**
 * Fetch a screen's code before its link is clicked (bead `ro-82x`).
 *
 * Every screen is its own file since the route split, so a click on a page not
 * yet visited waits for that file. The router's table owns which file an
 * address needs (`prefetchRoute` in `lib/lazy-route`), and `App.tsx` hands it
 * to the shell; the nav links ask for it when a pointer rests on them or the
 * keyboard focuses them, which is the moment before a click. Through context
 * rather than props because four different link components in this file carry
 * it. With no provider — the kitchen sink's standalone `Sidebar` — it does
 * nothing.
 */
const RoutePrefetch = createContext<((to: string) => void) | undefined>(undefined);

function useLinkIntent(): (to: string) => { onPointerEnter?: () => void; onFocus?: () => void } {
  const prefetch = useContext(RoutePrefetch);
  return (to) =>
    prefetch ? { onPointerEnter: () => prefetch(to), onFocus: () => prefetch(to) } : {};
}

export interface SidebarProps {
  theme: Theme;
  onToggleTheme: () => void;
  /** Called after any navigation — the mobile drawer closes itself on a click
   * that changes the page, because a drawer left open over the page it just
   * navigated to is a dead end. */
  onNavigate?: () => void;
  /** Opens the command palette. Optional because the gallery renders the
   * sidebar on its own; the button is always drawn, so the shortcut it
   * advertises is discoverable to someone who has never pressed ⌘K. */
  onOpenPalette?: () => void;
  /**
   * `/dev/kitchen-sink` only: the assets to list under Assets. Passing them also
   * keeps the gallery off `useWall` and off `localStorage` entirely — the demo
   * shows a fixture in a fixed state, not the store and not whatever the
   * reviewer last collapsed. The stance `CommandPalette` takes, for the same
   * reason.
   */
  assets?: AssetCard[];
  /**
   * Whether the asset list starts open when the operator has never said. `true`
   * on the desk column, `false` in the small-screen drawer — see `AssetNav`.
   */
  assetsDefaultOpen?: boolean;
  /**
   * `/dev/kitchen-sink` only: the credential payload the Integrations entry
   * reads its expiry dot from. Passing it (even as `null`) keeps the gallery off
   * the live query, exactly as `assets` keeps it off `useWall`.
   */
  credentials?: IntegrationCredentialsPayload | null;
  className?: string;
}

/**
 * The desk's one navigation surface (bead `ro-pbzu.1`).
 *
 * Every desk route used to draw its own idea of where to go next — a nav row on
 * Home, "← Home" on `/work` and `/health`, "← All properties" on `/financials`
 * and the asset page — so the operator's way around the product depended on
 * which page they happened to be standing on. This is the whole of it, in one
 * place, in one order, on every desk page.
 *
 * The footer holds what is not a page: the search button (bead `ro-d298`), the
 * TV and the theme. It carried the
 * changeset cart until D18 (bead `ro-pbzu.5`) — settings save in place now, so
 * there is nothing to review in a drawer and no write path living outside the
 * field being edited. The dev gallery (`/dev/kitchen-sink`) is reached by
 * URL. It is a reviewer's surface, not an operator's, and the nav is the
 * operator's list of places the product goes.
 */
export function Sidebar({
  theme,
  onToggleTheme,
  onNavigate,
  onOpenPalette,
  assets,
  assetsDefaultOpen = true,
  credentials,
  className,
}: SidebarProps) {
  const intent = useLinkIntent();
  return (
    <div
      className={cn("flex w-60 shrink-0 flex-col border-r border-border bg-card", className)}
      data-app-sidebar
    >
      <Link
        to="/"
        onClick={onNavigate}
        className="flex flex-col gap-0.5 px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BrandLockup />
      </Link>

      <WorkspaceButton className="mx-2 mb-2" />
      <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) =>
          // Assets is the one noun whose objects are also destinations, so it
          // is the one entry that carries a list (bead `ro-pbzu.9`).
          item.to === ASSETS_ROUTE ? (
            assets === undefined ? (
              <LiveAssetNav
                key={item.to}
                item={item}
                onNavigate={onNavigate}
                defaultOpen={assetsDefaultOpen}
              />
            ) : (
              <AssetNav
                key={item.to}
                item={item}
                assets={assets}
                remember={false}
                onNavigate={onNavigate}
                defaultOpen={assetsDefaultOpen}
              />
            )
          ) : item.to === INTEGRATIONS_ROUTE ? (
            credentials === undefined ? (
              <LiveIntegrationsNav key={item.to} item={item} onNavigate={onNavigate} />
            ) : (
              <IntegrationsNav
                key={item.to}
                item={item}
                payload={credentials}
                onNavigate={onNavigate}
              />
            )
          ) : (
            <PageNav key={item.to} item={item} onNavigate={onNavigate} />
          ),
        )}
      </nav>

      <div className="flex flex-col gap-1 border-t border-border p-2">
        {/* The palette's own affordance. ⌘K is the fast path, but a shortcut
         * nothing points at is a shortcut only its author knows — and a touch
         * operator has no modifier key at all. */}
        <button
          type="button"
          onClick={() => {
            onOpenPalette?.();
            onNavigate?.();
          }}
          // The palette's code arrives on first open (bead `ro-ujb9.84`); a
          // pointer resting here, or focus, fetches it before the click.
          onPointerEnter={() => void preloadCommandPalette()}
          onFocus={() => void preloadCommandPalette()}
          className={cn(ITEM_BASE, ITEM_IDLE, "w-full text-left")}
        >
          <Search className="size-4" />
          Search…
          <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘K</span>
        </button>
        {/* THE TV, AND ITS EDIT BESIDE IT (bead `ro-ujb9.96.7.12`). Arranging
            the Wall was Settings → TV dashboard → Edit layout → move → Save,
            with two screens that decided nothing; it is Edit here → move →
            Save now, PostHog's dashboard "Edit" pattern. The entry itself still
            opens the TV, which stays free of controls (flow D). */}
        <div className="flex items-center gap-0.5">
          <NavLink
            to={TV_ITEM.to}
            // `end`: the editor at /wall/edit lights its own Edit, not the TV.
            end
            onClick={onNavigate}
            {...intent(TV_ITEM.to)}
            className={({ isActive }) => cn(ITEM_BASE, "min-w-0 flex-1", isActive ? ITEM_ACTIVE : ITEM_IDLE)}
          >
            <TV_ITEM.icon className="size-4" />
            {TV_ITEM.label}
          </NavLink>
          <NavLink
            to={TV_EDIT_ITEM.to}
            onClick={onNavigate}
            {...intent(TV_EDIT_ITEM.to)}
            aria-label={TV_EDIT_ITEM.label}
            title={TV_EDIT_ITEM.label}
            data-tv-edit
            className={({ isActive }) =>
              cn(
                "flex shrink-0 items-center justify-center rounded-md p-1.5 outline-none max-md:size-11 focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? ITEM_ACTIVE : ITEM_IDLE,
              )
            }
          >
            <Pencil aria-hidden className="size-4" />
          </NavLink>
        </div>
        <div className="flex items-center gap-2 px-0.5 pt-1">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>
    </div>
  );
}

interface AssetNavProps {
  /** The Assets entry itself, so its label and icon are stated once. */
  item: NavItem;
  onNavigate?: () => void;
  /** The state when the operator has never said (the desk yes, the drawer no). */
  defaultOpen: boolean;
}

/**
 * The wall read, in its own component for the reason the palette's is: the
 * sidebar is mounted on every desk page, and the gallery — which hands its own
 * fixture in — must never reach the store. Every desk page that shows portfolio
 * numbers already runs this query, so on those pages this is the same cached
 * read rather than a second fetch.
 */
/**
 * Integrations, wearing the dot for a credential about to stop working (bead
 * `ro-vu8d.8`, doc 15 flow C step 4).
 *
 * WHY THE DOT IS HERE AND NOT IN THE ALERTS BAND. The flag lane cannot carry
 * this honestly — `flags.asset` is `NOT NULL REFERENCES assets(id)`, and a
 * portfolio-shared provider credential belongs to no single asset — and D15's
 * rule sends the fact to the action list rather than to a roll-up. The action
 * list is the provider card, where Reconnect is; this is the pointer that gets
 * an operator there without opening the page first, which is the whole
 * difference between a warning and a post-mortem.
 *
 * The severity scale, not a scale of its own: amber inside T-14d, red once
 * something has actually expired. An expiring credential is an ordinary warning
 * and inventing a colour for it would be inventing a fourth severity.
 *
 * The read is the SAME query the Integrations page uses, so opening the page
 * costs no second request and a Save there updates this dot through the shared
 * cache.
 */
/** One page entry, as every plain sidebar row draws it. */
function PageNav({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const intent = useLinkIntent();
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      {...intent(item.to)}
      className={({ isActive }) => cn(ITEM_BASE, isActive ? ITEM_ACTIVE : ITEM_IDLE)}
    >
      <item.icon className="size-4" />
      {item.label}
    </NavLink>
  );
}

function LiveIntegrationsNav({
  item,
  onNavigate,
}: {
  item: NavItem;
  onNavigate?: () => void;
}) {
  const { data } = useIntegrationProviders();
  return <IntegrationsNav item={item} payload={data ?? null} onNavigate={onNavigate} />;
}

function IntegrationsNav({
  item,
  payload,
  onNavigate,
}: {
  item: NavItem;
  payload: IntegrationCredentialsPayload | null;
  onNavigate?: () => void;
}) {
  const rows = expiringCredentials(payload, Date.now());
  const severity = expiringCredentialSeverity(rows);
  const intent = useLinkIntent();
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      {...intent(item.to)}
      className={({ isActive }) => cn(ITEM_BASE, isActive ? ITEM_ACTIVE : ITEM_IDLE)}
    >
      <item.icon className="size-4" />
      {item.label}
      {severity ? (
        <SeverityDot
          severity={severity}
          size="sm"
          className="ml-auto"
          title={expiringCredentialSummary(rows) ?? ""}
        />
      ) : null}
    </NavLink>
  );
}

function LiveAssetNav(props: AssetNavProps) {
  const { data } = useWall();
  return <AssetNav assets={data?.assets} remember {...props} />;
}

/**
 * The portfolio, under Assets (bead `ro-pbzu.9`).
 *
 * Reaching an asset used to be three hops from anywhere — Assets, the card, the
 * tab — for the page the operator opens most. Every asset-centric SaaS puts the
 * objects you live in one click from everywhere (Vercel's projects, Linear's
 * teams, Stripe's accounts), and this is that: one row per asset, always there,
 * lighting on any tab of the asset it points at.
 *
 * WHAT A ROW SAYS, AND NOTHING MORE. The favicon is identity, exactly as on the
 * cards and in the palette; a severity dot appears ONLY for an open warning or
 * error (doc 10 principle 3 — healthy needs no mark). Retired sites carry a
 * muted switched-off glyph; manual setup stages do not appear as nav health.
 *
 * The Assets entry above stays a link to the index and lights with its rows —
 * an asset page IS an asset — with the chevron as its own control beside it, so
 * expanding the list can never be mistaken for navigating.
 */
function AssetNav({
  item,
  assets,
  remember,
  onNavigate,
  defaultOpen,
}: AssetNavProps & {
  /** `undefined` while the first poll is in flight. */
  assets: AssetCard[] | undefined;
  /** Read and write `localStorage`. False in the gallery, whose state is its
   * fixture's rather than whatever the reviewer last collapsed in the app. */
  remember: boolean;
}) {
  const preferences = useOwnerPreferences();
  const [memory] = useState<NavAssetsMemory>(() => (remember ? readNavAssets(preferences) : { seen: 0 }));
  const [open, setOpen] = useState(memory.open ?? defaultOpen);
  // Both sidebars are in the DOM at once (the desk column and the drawer's
  // source), so the list this chevron controls needs an id per instance.
  const listId = useId();
  const intent = useLinkIntent();
  const { pathname } = useLocation();

  const ordered =assets === undefined ? undefined : navAssetOrder(assets);
  const visible = ordered?.slice(0, NAV_ASSET_LIMIT);
  const overflow = ordered !== undefined && ordered.length > NAV_ASSET_LIMIT;
  const drawn = visible?.length ?? null;

  // The row count is only recorded once a poll has answered: writing 0 while the
  // read is in flight would throw away the very number the next reload needs.
  useEffect(() => {
    if (!remember || drawn === null) return;
    patchNavAssets(preferences, { seen: drawn });
  }, [remember, drawn, preferences]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (remember) patchNavAssets(preferences, { open: next });
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-0.5">
        <NavLink
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          {...intent(item.to)}
          className={({ isActive }) =>
            cn(ITEM_BASE, "min-w-0 flex-1", isActive ? ITEM_ACTIVE : ITEM_IDLE)
          }
        >
          <item.icon className="size-4" />
          {item.label}
        </NavLink>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={open ? "Collapse the site list" : "Expand the site list"}
          onClick={toggle}
          className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground outline-none max-md:size-11 hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-90")}
          />
        </button>
      </div>

      {open ? (
        <ul id={listId} className="flex flex-col gap-0.5 pb-1 pl-3.5">
          {visible === undefined
            ? // Loading. The height the list HAD is reserved so the items below
              // it do not jump when the poll lands; before the first successful
              // read there is nothing to reserve and nothing is drawn. Muted
              // placeholders are hidden from assistive technology.
              Array.from({ length: memory.seen }, (_, index) => (
                <li key={index} aria-hidden className={ASSET_ROW_BASE}>
                  <span className="size-4 shrink-0 rounded-full bg-muted" />
                  <span className="h-2 w-24 rounded-sm bg-muted" />
                </li>
              ))
            : visible.map((asset) => {
                // A site opens where its next action is (`sitePath`, bead
                // `ro-ujb9.96.7.4`): its Data sources until the first number,
                // its Overview after. The row still lights on EVERY tab of
                // its site (`/assets/:id/signals`, `/assets/:id/tasks`),
                // because all of them are that site's page — so it is lit by
                // the site's address, not by the tab it opens on.
                const page = `${ASSETS_ROUTE}/${encodeURIComponent(asset.id)}`;
                const here = pathname === page || pathname.startsWith(`${page}/`);
                const to = sitePath(asset);
                return (
                <li key={asset.id}>
                  <Link
                    to={to}
                    data-nav-asset={asset.id}
                    onClick={onNavigate}
                    {...intent(to)}
                    aria-current={here ? "page" : undefined}
                    className={cn(ASSET_ROW_BASE, here ? ITEM_ACTIVE : ITEM_IDLE)}
                  >
                    <PropertyFavicon
                      domain={asset.id}
                      displayName={asset.displayName}
                      className="size-4"
                    />
                    {/* Two lines, never an ellipsis nobody can open on a phone
                        (bead ro-ujb9.13): the name is the row. */}
                    <span className="line-clamp-2 min-w-0 flex-1 break-words">{asset.displayName}</span>
                    {asset.status === "retired" ? <RetiredGlyph /> : null}
                    {asset.worstSeverity === "error" || asset.worstSeverity === "warn" ? (
                      <SeverityDot
                        severity={asset.worstSeverity}
                        size="sm"
                        title={openAlertsLabel(asset.openError, asset.openWarn)}
                      />
                    ) : null}
                  </Link>
                </li>
                );
              })}

          {overflow ? (
            // A plain `Link`, not a `NavLink`: it goes where the Assets entry
            // above already goes, and two rows carrying `aria-current="page"`
            // for one destination would say the same fact twice.
            <li>
              <Link
                to={ASSETS_ROUTE}
                onClick={onNavigate}
                className={cn(ASSET_ROW_BASE, ITEM_IDLE, "pl-2")}
              >
                All sites…
              </Link>
            </li>
          ) : null}

          <li>
            <NavLink
              to={`${ASSETS_ROUTE}/new`}
              onClick={onNavigate}
              {...intent(`${ASSETS_ROUTE}/new`)}
              className={({ isActive }) =>
                cn(ASSET_ROW_BASE, isActive ? ITEM_ACTIVE : ITEM_IDLE)
              }
            >
              <Plus aria-hidden className="size-4 shrink-0" />
              Add a site
            </NavLink>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

/** Retired sites keep a visible, accessible switched-off mark. */
function RetiredGlyph() {
  const label = assetStatusLabel("retired");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex shrink-0 items-center text-muted-foreground/70"
    >
      <CircleSlash2 aria-hidden className="size-3" />
    </span>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

/**
 * The desk shell: navigation on the left, the page in the middle, nothing else.
 *
 * `/wall` renders OUTSIDE this layout route on purpose. The TV is read-only and
 * its tokens assume the dark emissive palette, so it gets neither the sidebar
 * nor the theme class — which is also why the `.light` class is applied here and
 * removed on unmount, rather than by the theme hook. The command palette is
 * mounted here for the same reason: the television has no keyboard and nothing
 * to navigate to.
 *
 * The DESK column defaults the asset list open and the DRAWER defaults it
 * closed (bead `ro-pbzu.9`): a drawer is opened to go one specific place, and a
 * sublist of six between the operator and Alerts is in the way.
 */
export function AppShell({
  onPrefetch,
}: {
  /** Fetch the code behind an address before it is visited (bead `ro-82x`);
   * `App.tsx` passes the router table's prefetcher. */
  onPrefetch?: (to: string) => void;
} = {}) {
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  // The palette is mounted HERE, which is precisely why `/wall` cannot have it:
  // the television renders outside this layout route (bead `ro-d298`).
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    return () => root.classList.remove("light");
  }, [theme]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <RoutePrefetch.Provider value={onPrefetch}>
      <div className="flex min-h-screen">
        <Sidebar
          theme={theme}
          onToggleTheme={toggle}
          onOpenPalette={() => setPaletteOpen(true)}
          className="sticky top-0 hidden h-screen md:flex"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-card px-3 md:hidden">
            {/* The nav's own mark, on the button that hides the nav (bead
              * `ro-vu8d.19`). The sidebar's Integrations entry wears a severity
              * dot when a shared credential is inside its fourteen days, and
              * `ro-vu8d.19` decided that dot plus the provider card is the whole
              * ceiling — the Wall and Home's Alerts list deliberately carry
              * nothing, because the action list owns the fact (D15) and nobody
              * can reconnect from a television. A ceiling the operator cannot see
              * on their phone is not a ceiling, so it travels here: same
              * predicate, same sentence, no second vocabulary. */}
            <span className="relative inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Open navigation"
                onClick={() => setMenuOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              <NavAlarm />
            </span>
            {/* THE HEIGHT IS CLAIMED, NOT ADDED (bead `ro-9smi`, the pattern
              * `ro-khoy` used). This row is already `h-12` and the wordmark was a
              * 20px link floating in the middle of it — the one control under the
              * thumb target on EVERY desk route, since this header is the phone's
              * whole navigation chrome. `min-h-11` fills the space it was already
              * sitting in, so nothing moves and nothing is drawn differently.
              * Unconditional rather than `max-sm:`, because the header itself is
              * `md:hidden`: every viewport that can see this link is a touch one. */}
            <Link
              to="/"
              className="flex min-h-11 items-center text-sm font-semibold tracking-tight"
            >
              <BrandLockup size="compact" />
            </Link>
            <WorkspaceButton className="ml-auto max-w-44" />
          </div>

          <DemoViewerStatus />
          <main className="min-w-0 flex-1">
            <Outlet />
          </main>
        </div>

        {menuOpen
          ? createPortal(
              <NavDrawer
                theme={theme}
                onToggleTheme={toggle}
                onOpenPalette={() => setPaletteOpen(true)}
                onClose={() => setMenuOpen(false)}
              />,
              document.body,
            )
          : null}

        <PaletteLauncher open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </RoutePrefetch.Provider>
  );
}

/**
 * The command palette's shortcut and mount (bead `ro-ujb9.84`).
 *
 * The palette's code — cmdk and the dialog — is fetched on first open rather
 * than with the shell, so what the shell keeps is what must work before that:
 * the ⌘K / Ctrl+K binding (moved here from the palette, which no longer exists
 * until it is wanted) and the mount. The very first press opens the palette:
 * the open is state here, the palette is drawn from that moment on, and until
 * its code has arrived the `<Suspense>` shows nothing at all — no empty box, no
 * list-shaped placeholder — and then the palette appears already open, focused
 * on its field. Pressing the modifier alone starts the fetch, which usually
 * lands it before the K.
 *
 * Nothing is drawn before the first open, because drawing the lazy palette is
 * what fetches it. From then on it stays mounted, closed, like it always did.
 */
function PaletteLauncher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [wanted, setWanted] = useState(open);
  if (open && !wanted) setWanted(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isPaletteModifier(event)) {
        void preloadCommandPalette();
        return;
      }
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange, open]);

  if (!wanted) return null;
  return (
    <Suspense fallback={<RouteLoading surface="palette" />}>
      <LazyCommandPalette open={open} onOpenChange={onOpenChange} />
    </Suspense>
  );
}

/**
 * WHAT THE HIDDEN NAV WOULD HAVE SHOWN, on the button hiding it (bead
 * `ro-vu8d.19`).
 *
 * The one mark the sidebar carries that is not per-page is the Integrations
 * entry's expiry dot, and `ro-vu8d.19` decided that dot — with the provider
 * card behind it — is the whole ceiling for an expiring shared credential: the
 * Wall carries nothing, because it is a television nobody can reconnect from
 * and the fact is owned by the action list (D15), and Home carries nothing
 * extra, because Home is a desk page and the sidebar is already on it.
 *
 * Below `md` the sidebar is not on it. So the mark travels to the bar, reading
 * the same rows through the same predicate and saying the same sentence. It
 * adds no second control — `pointer-events-none`, so the whole target stays the
 * button it sits on, which is what the operator presses either way; the dot's
 * job is to make them press it. It keeps `SeverityDot`'s own `role="img"` and
 * sentence rather than hiding from a screen reader, because "Open navigation"
 * followed by "DataForSEO — expires in 9 days" is the same two facts the sighted
 * operator gets.
 *
 * Nothing else in the sidebar earns a badge here. Alert and task counts are on
 * the pages they belong to, and a bar that accumulated every one of them would
 * be the roll-up D15 exists to stop.
 */
function NavAlarm() {
  const { data } = useIntegrationProviders();
  const rows = expiringCredentials(data ?? null, Date.now());
  const severity = expiringCredentialSeverity(rows);
  if (!severity) return null;
  return (
    <span
      data-nav-alarm={severity}
      title={expiringCredentialSummary(rows) ?? ""}
      className="pointer-events-none absolute right-1 top-1"
    >
      <SeverityDot severity={severity} size="sm" />
    </span>
  );
}

function NavDrawer({
  theme,
  onToggleTheme,
  onOpenPalette,
  onClose,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex md:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="relative flex h-full"
      >
        <Sidebar
          theme={theme}
          onToggleTheme={onToggleTheme}
          onNavigate={onClose}
          onOpenPalette={onOpenPalette}
          // A drawer is opened to go one specific place; six asset rows between
          // the operator and Alerts are in the way of most of those places. An
          // explicit toggle still travels — it is the operator's choice, not the
          // surface's — but nobody has to make it to use the drawer.
          assetsDefaultOpen={false}
          className="h-full shadow-xl"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-2 top-2"
        >
          <X className="size-4" />
        </Button>
      </aside>
    </div>
  );
}

export default AppShell;

/** Workspace selection is tab-local; its label is a verified bootstrap fact. */
function WorkspaceButton({ className }: { className?: string }) {
  const { workspaceLabel, switchWorkspace, logout } = useBrowserContext();
  return switchWorkspace && workspaceLabel ? <div className={cn('flex min-w-0 items-center gap-1', className)}>
    <Button variant="outline" className="min-w-0 flex-1" aria-label={`Switch workspace: ${workspaceLabel}`} onClick={switchWorkspace}>
      <span className="truncate">{workspaceLabel}</span>
    </Button>
    <Button variant="ghost" onClick={() => void logout?.()} aria-label="Sign out">Sign out</Button>
  </div> : null;
}
