import { useMemo, type CSSProperties } from "react";
import type { DashboardConfig } from "@shared/dashboard";
import { DEFAULT_WALL_LAYOUT, parseWallConfig, type WallLayout } from "@shared/wall-layout";
import { ReadFailed } from "@/components/ReadFailed";
import { RouteLoading } from "@/components/RouteLoading";
import { WallCanvas } from "@/components/WallCanvas";
import { DemoViewerStatus } from '@/components/DemoViewerStatus';
import { useCalendarUpcoming } from "@/hooks/useCalendarUpcoming";
import { useNow } from "@/hooks/useNow";
import { useConnections } from "@/hooks/useConnections";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useWall } from "@/hooks/useWall";
import { useWallWeather } from "@/hooks/useWallWeather";
import { useWallScreen } from "@/hooks/useWallScreen";
import { useDocumentTitle } from "@/lib/document-title";
import { useBootSplashRelease } from "@/lib/boot-splash";
import { TV_ITEM } from "@/components/nav-items";
import { calendarReadState } from "@/lib/meetings";
import { wallWithAttentionStrip } from "@/lib/wall-attention-layout";

/** The saved Wall composition, with one independent fallback for every viewer. */
export function drawnLayout(dashboard: { wall?: DashboardConfig["wall"] | null }): WallLayout {
  if (dashboard.wall === undefined || dashboard.wall === null) return DEFAULT_WALL_LAYOUT;
  try {
    return wallWithAttentionStrip(parseWallConfig(dashboard.wall).layout);
  } catch {
    return DEFAULT_WALL_LAYOUT;
  }
}

/**
 * /wall: the read-only TV. Its layout and presentation are independent of
 * personal and workspace views, including in the public demo.
 * Nothing that edits or acts may reach this bundle; the route-split journey
 * fails if desk editing or task code is fetched.
 */
export function WallRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const realtime = useGa4Realtime();
  const upcoming = useCalendarUpcoming();
  // The same two reads Integrations derives every status from, so a site's
  // issue mark and the strip's state cannot disagree with it.
  const { credentials, items, events } = useConnections();
  const now = useNow();
  const screen = useWallScreen();
  // The shell's name for this view, on the tab a TV shows.
  useDocumentTitle(TV_ITEM.label);
  useBootSplashRelease();
  const dashboard = data?.dashboard;
  const layout = useMemo(() => dashboard ? drawnLayout(dashboard) : null, [dashboard]);
  const weather = useWallWeather(layout, now);

  if (!data || layout === null) {
    if (isError) {
      return <><DemoViewerStatus /><ReadFailed surface="wall" title="Couldn't load the Wall" subject="read:wall" error={error} retrying={isFetching} onRetry={() => void refetch()} /></>;
    }
    return <><DemoViewerStatus /><RouteLoading surface="wall" /></>;
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
      data-wall-screen
      data-wall-kiosk={screen.kiosk || undefined}
      data-wall-compact={screen.compact || undefined}
      data-wall-small-insets={screen.viewportWidth < 768 || undefined}
      style={{ "--wall-scale": screen.scale, "--wall-render-zoom": screen.zoom, "--wall-viewport-height": `${screen.viewportHeight}px` } as CSSProperties}
    >
      <DemoViewerStatus className="mb-2 px-0" />
      <WallCanvas
        layout={layout}
        data={data}
        nowMs={now}
        meetings={upcoming.data}
        calendarState={calendarReadState(upcoming)}
        weather={weather}
        ga4Realtime={realtime.data}
        ga4RealtimeError={realtime.isError}
        lastGood={isError}
        connections={{ credentials, items, events }}
      />
    </div>
  );
}

export default WallRoute;
