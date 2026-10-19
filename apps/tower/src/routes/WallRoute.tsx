import { useCallback, useMemo, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import type { DashboardConfig } from "@shared/dashboard";
import { DEFAULT_WALL_LAYOUT, WALL_PRESETS, parseWallConfig, wallLayoutWidgets, type WallLayout } from "@shared/wall-layout";
import { DEFAULT_VIEW, isViewId, type ViewId } from "@shared/views";
import { ReadFailed } from "@/components/ReadFailed";
import { RouteLoading } from "@/components/RouteLoading";
import { WallCanvas } from "@/components/WallCanvas";
import { DemoViewerStatus } from '@/components/DemoViewerStatus';
import { DemoViewSwitch } from '@/components/DemoViewSwitch';
import { useCalendarUpcoming } from "@/hooks/useCalendarUpcoming";
import { useNow } from "@/hooks/useNow";
import { useConnections } from "@/hooks/useConnections";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useWall } from "@/hooks/useWall";
import { useWallScreen } from "@/hooks/useWallScreen";
import { useView } from "@/hooks/useView";
import { useDemoReadonly } from "@/lib/browser-context";
import { useDocumentTitle } from "@/lib/document-title";
import { useBootSplashRelease } from "@/lib/boot-splash";
import { TV_ITEM } from "@/components/nav-items";
import { calendarReadState } from "@/lib/meetings";

/**
 * The layout the TV draws, read with the contract's own rule. A saved layout
 * always wins; with none saved, the TV draws the workspace view's preset
 * (`WALL_PRESETS`). The Worker has parsed it already; reading it again here
 * is what makes "never blank" hold for any payload: one naming a retired
 * widget, or one nothing can draw, is the default, named once in the
 * contract. The editor is where an unreadable save is said out loud.
 */
export function drawnLayout(dashboard: Pick<DashboardConfig, "wall" | "view">): WallLayout {
  if (dashboard.wall === undefined || dashboard.wall === null) {
    return WALL_PRESETS[dashboard.view?.default ?? DEFAULT_VIEW];
  }
  try {
    return parseWallConfig(dashboard.wall).layout;
  } catch {
    return DEFAULT_WALL_LAYOUT;
  }
}

/**
 * The demo's TV in the view a visitor picked: that view's preset in place of
 * the saved layout, with the saved site rows' chosen totals carried over so
 * they survive. No pick draws `drawnLayout`; Everything keeps a saved layout,
 * which in the demo is the default plus those totals. Only the demo calls
 * this; an installation's TV draws `drawnLayout` alone.
 */
export function demoDrawnLayout(dashboard: Pick<DashboardConfig, "wall" | "view">, view: ViewId | null): WallLayout {
  const saved = drawnLayout(dashboard);
  if (view === null) return saved;
  if (view === "everything" && dashboard.wall !== undefined && dashboard.wall !== null) return saved;
  const preset = WALL_PRESETS[view];
  const pulseMetrics = wallLayoutWidgets(saved).find((widget) => widget.type === "sites")?.settings?.pulseMetrics;
  if (pulseMetrics === undefined || !wallLayoutWidgets(preset).some((widget) => widget.type === "sites")) return preset;
  const layout = structuredClone(preset) as WallLayout;
  for (const widget of wallLayoutWidgets(layout)) {
    if (widget.type === "sites") widget.settings = { ...widget.settings, pulseMetrics: structuredClone(pulseMetrics) };
  }
  return layout;
}

/** The view a demo visitor asked the TV for: a `?view=` link first, then their own pick. */
function demoTvView(query: string | null, chosen: ViewId | null): ViewId | null {
  if (query !== null && isViewId(query)) return query;
  return chosen;
}

/**
 * /wall: the TV, read-only. Everything on it is `WallCanvas` drawing the
 * layout saved at `config/tower.json` `/wall`, else the workspace view's preset;
 * in the demo, the visitor's pick (`demoDrawnLayout`), switched in the demo bar
 * above the canvas so the canvas keeps nothing to press.
 * Nothing that edits or acts may reach this bundle; the route-split journey
 * (`e2e/journeys.spec.ts`) fails if desk editing or task code is fetched.
 */
export function WallRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const realtime = useGa4Realtime();
  const upcoming = useCalendarUpcoming();
  // The same two reads Integrations derives every status from, so a site's
  // issue mark and the strip's state cannot disagree with it.
  const { credentials, items } = useConnections();
  const now = useNow();
  const screen = useWallScreen();
  // The shell's name for this view, on the tab a TV shows.
  useDocumentTitle(TV_ITEM.label);
  useBootSplashRelease();
  // In the demo the TV follows the visitor's pick, or a `?view=` link a
  // kiosk opens; an installation's TV keeps its saved layout or preset.
  const demo = useDemoReadonly();
  const { choice, source } = useView();
  const [params, setParams] = useSearchParams();
  const tvView = demo ? demoTvView(params.get("view"), source === "person" ? choice.view : null) : null;
  // A press replaces the link's view, so the TV follows the press.
  const onChosen = useCallback(() => {
    setParams((current) => {
      if (!current.has("view")) return current;
      const next = new URLSearchParams(current);
      next.delete("view");
      return next;
    }, { replace: true });
  }, [setParams]);
  const viewSwitch = demo ? <DemoViewSwitch value={tvView ?? undefined} onChosen={onChosen} /> : undefined;
  const dashboard = data?.dashboard;
  const layout = useMemo(() => {
    if (!dashboard) return null;
    return demo ? demoDrawnLayout(dashboard, tvView) : drawnLayout(dashboard);
  }, [dashboard, demo, tvView]);

  if (!data || layout === null) {
    if (isError) {
      return <><DemoViewerStatus viewSwitch={viewSwitch} /><ReadFailed surface="wall" title="Couldn't load the Wall" subject="read:wall" error={error} retrying={isFetching} onRetry={() => void refetch()} /></>;
    }
    return <><DemoViewerStatus viewSwitch={viewSwitch} /><RouteLoading surface="wall" /></>;
  }

  // A laptop or a landscape tablet draws the TV's layout, scaled to fit it
  // (`wallScreen`): index.css zooms the whole Wall by this one number and
  // keeps the small type above its floor.
  const scaled = screen.layout === "tv" && screen.scale < 1;

  return (
    /* The Wall's frame: 24px top and bottom, 32px sides on the TV, and the
       canvas takes the rest. This is the one page in the product with a fixed
       height, so every pixel of inset is one the site rows do not get. */
    <div
      className="wall-root flex min-h-screen flex-col bg-background p-2 md:px-wall-inset-x md:py-wall-inset-y"
      data-wall-layout={screen.layout}
      data-wall-scaled={scaled ? "" : undefined}
      style={scaled ? ({ "--wall-scale": screen.scale } as CSSProperties) : undefined}
    >
      <DemoViewerStatus className="mb-2 px-0" viewSwitch={viewSwitch} />
      <WallCanvas
        layout={layout}
        data={data}
        nowMs={now}
        meetings={upcoming.data}
        calendarState={calendarReadState(upcoming)}
        ga4Realtime={realtime.data}
        ga4RealtimeError={realtime.isError}
        lastGood={isError}
        connections={{ credentials, items }}
      />
    </div>
  );
}

export default WallRoute;
