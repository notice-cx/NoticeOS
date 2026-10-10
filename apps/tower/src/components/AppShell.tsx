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

// The nav list lives in its own module so `CommandPalette`, which the shell
// mounts, can read it without importing the shell back.
export { NAV_ITEMS, TV_ITEM, PAGE_ITEMS, type NavItem } from "@/components/nav-items";

// `max-md:min-h-11`: below `md` the only sidebar in the DOM is the drawer's,
// whose rows must meet the thumb target.
const ITEM_BASE = "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none max-md:min-h-11 focus-visible:ring-2 focus-visible:ring-ring";
const ITEM_ACTIVE = "bg-accent-soft text-primary font-medium";
const ITEM_IDLE = "text-muted-foreground hover:bg-muted/60 hover:text-foreground";

const ASSET_ROW_BASE = "flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-2.5 text-xs outline-none max-md:min-h-11 focus-visible:ring-2 focus-visible:ring-ring";

/** Above this many assets the nav shows the leading slice plus "All sites…". */
const NAV_ASSET_LIMIT = 12;

/** Where the sidebar remembers the asset list: whether it is open, and how
 * many rows it drew last time, so a reload reserves the right height before
 * the poll lands. */
const NAV_ASSETS_NAME = "nav-assets";
export const NAV_ASSETS_KEY = storageKey(NAV_ASSETS_NAME);

interface NavAssetsMemory {
  /** Absent until the operator has worked the chevron: the default belongs to
   * the surface (open on the desk column, closed in the drawer), and the desk
   * column mounts first, so writing it would leak into the drawer. */
  open?: boolean;
  /** Rows drawn on the last render that had data. 0 = nothing to reserve. */
  seen: number;
}

/** A storage read that fails must leave a working nav, not a blank screen. */
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
 * events from two sidebars in the DOM. */
function patchNavAssets(preferences: ReturnType<typeof useOwnerPreferences>, patch: Partial<NavAssetsMemory>): void {
  try {
    preferences.write(
      NAV_ASSETS_NAME,
      JSON.stringify({ ...readNavAssets(preferences), ...patch }),
    );
  } catch {
    /* storage disabled or full: the list still works, it just forgets */
  }
}

/** The payload's own order (the index's default is the absence of a sort),
 * with retired assets sunk to the foot. `Array#sort` is stable. */
function navAssetOrder(assets: AssetCard[]): AssetCard[] {
  const sunk = (asset: AssetCard) => (asset.status === "retired" ? 1 : 0);
  return [...assets].sort((a, b) => sunk(a) - sunk(b));
}

/** Fetch a screen's code when a pointer rests on its link or focus lands on
 * it. `App.tsx` provides the router table's prefetcher; with no provider (the
 * gallery's standalone `Sidebar`) it does nothing. */
const RoutePrefetch = createContext<((to: string) => void) | undefined>(undefined);

function useLinkIntent(): (to: string) => { onPointerEnter?: () => void; onFocus?: () => void } {
  const prefetch = useContext(RoutePrefetch);
  return (to) =>
    prefetch ? { onPointerEnter: () => prefetch(to), onFocus: () => prefetch(to) } : {};
}

export interface SidebarProps {
  theme: Theme;
  onToggleTheme: () => void;
  /** Called after any navigation, so the mobile drawer can close itself. */
  onNavigate?: () => void;
  /** Opens the command palette. Optional because the gallery renders the
   * sidebar on its own; the button is always drawn. */
  onOpenPalette?: () => void;
  /** Gallery only: the assets to list under Assets. Passing them keeps the
   * gallery off `useWall` and off `localStorage`. */
  assets?: AssetCard[];
  /** Whether the asset list starts open when the operator has never said:
   * `true` on the desk column, `false` in the small-screen drawer. */
  assetsDefaultOpen?: boolean;
  /** Gallery only: the credential payload the Integrations entry reads its
   * expiry dot from. Passing it (even as `null`) keeps the gallery off the live query. */
  credentials?: IntegrationCredentialsPayload | null;
  className?: string;
}

/**
 * The desk's one navigation surface, on every desk page. The footer holds
 * what is not a page: search, the TV and the theme. The dev gallery is
 * reached by URL only.
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
          // Assets is the one noun whose objects are also destinations.
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
        <button
          type="button"
          onClick={() => {
            onOpenPalette?.();
            onNavigate?.();
          }}
          // The palette's code arrives on first open; hover or focus fetches it early.
          onPointerEnter={() => void preloadCommandPalette()}
          onFocus={() => void preloadCommandPalette()}
          className={cn(ITEM_BASE, ITEM_IDLE, "w-full text-left")}
        >
          <Search className="size-4" />
          Search…
          <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘K</span>
        </button>
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
  item: NavItem;
  onNavigate?: () => void;
  /** The state when the operator has never said (the desk yes, the drawer no). */
  defaultOpen: boolean;
}

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

// Live reads sit in their own components so the gallery, which hands fixtures
// in, never reaches the store. The same cached queries the pages run.
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

/** Integrations wears a severity dot for a credential about to stop working.
 * A shared credential belongs to no asset, so the flag lane cannot carry it;
 * the pointer to the provider card lives here instead. */
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
 * One row per asset under Assets, lighting on any tab of the asset it points
 * at. A severity dot appears only for an open warning or error; retired sites
 * carry a muted switched-off glyph. The chevron is its own control, so
 * expanding the list is never mistaken for navigating.
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
  /** Read and write `localStorage`. False in the gallery. */
  remember: boolean;
}) {
  const preferences = useOwnerPreferences();
  const [memory] = useState<NavAssetsMemory>(() => (remember ? readNavAssets(preferences) : { seen: 0 }));
  const [open, setOpen] = useState(memory.open ?? defaultOpen);
  // Both sidebars can be in the DOM at once, so the list needs an id per instance.
  const listId = useId();
  const intent = useLinkIntent();
  const { pathname } = useLocation();

  const ordered =assets === undefined ? undefined : navAssetOrder(assets);
  const visible = ordered?.slice(0, NAV_ASSET_LIMIT);
  const overflow = ordered !== undefined && ordered.length > NAV_ASSET_LIMIT;
  const drawn = visible?.length ?? null;

  // Recorded only once a poll has answered: writing 0 while the read is in
  // flight would throw away the number the next reload needs.
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
            ? // Loading: the height the list had is reserved so the items
              // below do not jump when the poll lands.
              Array.from({ length: memory.seen }, (_, index) => (
                <li key={index} aria-hidden className={ASSET_ROW_BASE}>
                  <span className="size-4 shrink-0 rounded-full bg-muted" />
                  <span className="h-2 w-24 rounded-sm bg-muted" />
                </li>
              ))
            : visible.map((asset) => {
                // A site opens where its next action is (`sitePath`), but the
                // row lights on every tab of its site.
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
                    {/* Two lines, never an ellipsis nobody can open on a phone. */}
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
            // A plain `Link`: the Assets entry above already carries
            // `aria-current` for this destination.
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
 * The desk shell: navigation on the left, the page in the middle. `/wall`
 * renders outside this layout route: the TV's tokens assume the dark emissive
 * palette, so it gets neither the sidebar, the palette nor the theme class,
 * which is why `.light` is applied here and removed on unmount rather than by
 * the theme hook.
 */
export function AppShell({
  onPrefetch,
}: {
  /** Fetch the code behind an address before it is visited; `App.tsx` passes
   * the router table's prefetcher. */
  onPrefetch?: (to: string) => void;
} = {}) {
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
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
            {/* `min-h-11` unconditionally: the header is `md:hidden`, so every
                viewport that sees this link is a touch one. */}
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
 * The palette's shortcut and mount. Its code is fetched on first open, so the
 * binding lives here; nothing is drawn before the first open, because drawing
 * the lazy palette is what fetches it. Pressing the modifier alone starts the
 * fetch.
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
 * The Integrations entry's expiry dot, on the button that hides the nav below
 * `md`: same rows, same predicate. `pointer-events-none` keeps the whole
 * target the button it sits on. Nothing else earns a badge here; alert and
 * task counts stay on their pages.
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
          // A drawer is opened to go one specific place; an explicit toggle
          // still travels.
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
