import type { CSSProperties } from "react";
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
import { useWallScreen } from "@/hooks/useWallScreen";
import { useDocumentTitle } from "@/lib/document-title";
import { TV_ITEM } from "@/components/nav-items";
import { calendarReadState } from "@/lib/meetings";

/**
 * The layout the TV draws, read with the contract's own rule. The Worker has
 * parsed it already; reading it again here is what makes "never blank" hold
 * for any payload: no layout, one naming a retired widget, or one nothing can
 * draw is the default, named once in the contract. The editor is where an
 * unreadable save is said out loud.
 */
function drawnLayout(wall: unknown): WallLayout {
  try {
    return parseWallConfig(wall).layout;
  } catch {
    return DEFAULT_WALL_LAYOUT;
  }
}

/**
 * /wall: the TV, read-only. Everything on it is `WallCanvas` drawing the
 * layout saved at `config/tower.json` `/wall`, else `DEFAULT_WALL_LAYOUT`.
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

  if (!data) {
    if (isError) {
      return <><DemoViewerStatus /><ReadFailed surface="wall" title="Couldn't load the Wall" subject="read:wall" error={error} retrying={isFetching} onRetry={() => void refetch()} /></>;
    }
    return <><DemoViewerStatus /><RouteLoading surface="wall" /></>;
  }

  const layout = drawnLayout(data.dashboard.wall);
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
      <DemoViewerStatus className="mb-2 px-0" />
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
