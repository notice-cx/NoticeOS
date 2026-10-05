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
import { calendarReadState } from "@/lib/meetings";

/**
 * The layout the TV draws, read with the contract's own rule. The Worker has
 * parsed it already; reading it again here is what makes "never blank" hold
 * for any payload (bead `ro-trai.11`): no layout, one naming a widget D28
 * retired, or one nothing can draw is the default — the default is named once,
 * in the contract. The editor is where an unreadable save is said out loud.
 */
function drawnLayout(wall: unknown): WallLayout {
  try {
    return parseWallConfig(wall).layout;
  } catch {
    return DEFAULT_WALL_LAYOUT;
  }
}

/**
 * /wall — the TV. Full-screen, dark, auto-refreshing (60s via useWall),
 * read-only (doc 10). A failed poll keeps the last-good payload (TanStack
 * Query), and the strip then says how old it is.
 *
 * THE COMPOSITION IS A DOCUMENT, NOT THIS FILE (epic `ro-lzmq`). Everything on
 * the TV is `WallCanvas` drawing the layout saved at `config/tower.json`
 * `/wall`; with none saved that is `DEFAULT_WALL_LAYOUT`, D28's arrangement
 * (docs/25-the-wall.md, bead `ro-trai.11`).
 *
 * NO HEADER ROW SINCE D28. The route's old header carried identity, a Home
 * link, the Tasks legend, an Integrations link and the payload's age. Each has
 * one home now: identity, time and the one system state are the strip's, and
 * its brand is the TV's one link, Home (doc 14); urgent tasks are Needs you's
 * count; integrations failing become the strip's state and a site's issue
 * mark; the age appears only when a poll fails.
 *
 * NOTHING THAT EDITS OR ACTS REACHES THIS BUNDLE, AND A JOURNEY CHECKS IT. The
 * editor at `/wall/edit` passes `WallCanvas` an `editing` slot for selection and
 * drag chrome; the TV passes none (docs/15 flow D: edit mode is never on the
 * TV). The route-split journey (`e2e/journeys.spec.ts`) lists every module
 * `/wall` fetches and fails if desk editing or task code, or a module of a
 * widget D28 retired, is among them.
 */
export function WallRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const realtime = useGa4Realtime();
  const upcoming = useCalendarUpcoming();
  // The same two reads Integrations derives every status from, so a site's
  // issue mark and the strip's state cannot disagree with it (bead
  // `ro-ujb9.96.7.16`).
  const { credentials, items } = useConnections();
  const now = useNow();
  const screen = useWallScreen();

  if (!data) {
    if (isError) {
      return <><DemoViewerStatus /><ReadFailed surface="wall" title="Couldn't load the Wall" subject="read:wall" error={error} retrying={isFetching} onRetry={() => void refetch()} /></>;
    }
    return <><DemoViewerStatus /><RouteLoading surface="wall" /></>;
  }

  const layout = drawnLayout(data.dashboard.wall);
  // A laptop or a landscape tablet draws the TV's layout, scaled to fit it
  // (bead ro-trai.31, `wallScreen`): index.css zooms the whole Wall by this one
  // number and keeps the small type above its floor.
  const scaled = screen.layout === "tv" && screen.scale < 1;

  return (
    /* D28's frame (docs/25 § Budget): 24px top and bottom, 32px sides on the
       TV, and the canvas takes the rest. This is the one page in the product
       with a fixed height, so every pixel of inset is one the site rows do not
       get. */
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
