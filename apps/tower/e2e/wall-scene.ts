// The fixture's Wall, set up once. The Wall journeys draw the same synthetic Wall (wall-fixture.ts): the same
// clock pin and the same five reads answered from the fixture. `wallScene`
// registers those reads once, each payload built once per variant.
// `wallAt` shows the Wall at a screen size: the first call loads it, and later
// calls resize the window the Wall is already drawn in, as a laptop's window
// or a turned tablet would. Data that does not change is not loaded again.
// `openWall` always loads, for a journey that needs a cold start at a size.
//
// Every load is a new tab's: the Wall keeps its last realtime and calendar
// readings in sessionStorage, and a restored reading from an earlier load
// would measure the wrong variant's Wall.
import type { Page } from "@playwright/test";
import type { StoredViewId } from "../shared/views";
import type { WallLayout } from "../shared/wall-layout";
import { expect } from "./journey-test";
import { weatherScene } from "./wall-weather-fixture";
import {
  WALL_FIXTURE_NOW, wallFixtureCalendar, wallFixtureHealth, wallFixturePayload, wallFixtureProviders, wallFixtureRealtime,
  type WallFixtureVariant,
} from "./wall-fixture";

type WallReads = Record<"wall" | "realtime" | "calendar" | "health" | "providers", unknown>;

/**
 * A saved layout that places the live feed and Needs you, which the default
 * leaves in the library: the strip, then a column of revenue beside Needs you
 * over the site rows, beside the full-height feed. The feed's journeys draw it.
 */
export const WALL_FEED_LAYOUT: WallLayout = {
  version: 1,
  rows: [
    { id: "strip", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] },
    {
      id: "body",
      height: "fill",
      widgets: [
        {
          id: "business",
          type: "column",
          width: 3.1,
          rows: [
            { id: "money", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1.55 }, { id: "needs", type: "needs", width: 1 }] },
            { id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] },
          ],
        },
        { id: "feed", type: "feed", width: 1 },
      ],
    },
  ],
};

export interface WallScene {
  /** What the Wall's next reads answer; a journey may switch it between loads. */
  variant: WallFixtureVariant;
}

/**
 * Answer the Wall's reads from the fixture's `variant`, and pin the browser's
 * clock at the fixture's 12:30 PM PT unless `clock` is false: the live-feed
 * journey runs on the journey server's own clock. With `layout`, the payload
 * carries it as the saved layout; without, the Wall draws its own default.
 * `view` sets a workspace default to verify Wall independence.
 */
export async function wallScene(
  page: Page,
  variant: WallFixtureVariant = "six",
  { clock = true, layout, view }: { clock?: boolean; layout?: WallLayout; view?: StoredViewId } = {},
): Promise<WallScene> {
  const scene: WallScene = { variant };
  const built = new Map<WallFixtureVariant, WallReads>();
  const reads = () => {
    let found = built.get(scene.variant);
    if (!found) {
      found = {
        wall: savedLayout(wallFixturePayload(scene.variant), layout, view),
        realtime: wallFixtureRealtime(20, scene.variant),
        calendar: wallFixtureCalendar(),
        health: wallFixtureHealth(scene.variant),
        providers: wallFixtureProviders(),
      };
      built.set(scene.variant, found);
    }
    return found;
  };
  if (clock) await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
  await page.addInitScript(() => sessionStorage.clear());
  await weatherScene(page);
  await page.route("**/api/wall", (route) => route.fulfill({ json: reads().wall }));
  await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: reads().realtime }));
  await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: reads().calendar }));
  await page.route("**/api/integrations/health", (route) => route.fulfill({ json: reads().health }));
  await page.route("**/api/integrations/providers", (route) => route.fulfill({ json: reads().providers }));
  return scene;
}

function savedLayout(payload: ReturnType<typeof wallFixturePayload>, layout: WallLayout | undefined, view: StoredViewId | undefined) {
  const dashboard = view ? { ...payload.dashboard, view: { default: view } } : payload.dashboard;
  return { ...payload, dashboard: layout ? { ...dashboard, wall: { layout, history: [] } } : dashboard };
}

type Size = readonly [width: number, height: number];

/** Load the Wall at `size`, and wait until it has drawn and stopped moving. */
export async function openWall(page: Page, [width, height]: Size) {
  await page.setViewportSize({ width, height });
  await page.goto("/wall");
  await expect(page.locator(".wall-root")).toBeAttached();
  await wallSettled(page);
}

/** The Wall at `size`: loaded if the page is not showing it, otherwise
 * re-laid out in place at the new size. */
export async function wallAt(page: Page, size: Size) {
  if (new URL(page.url(), "http://unloaded.invalid").pathname !== "/wall") return openWall(page, size);
  const [width, height] = size;
  await page.setViewportSize({ width, height });
  await wallSettled(page);
}

/**
 * Wait until the Wall has drawn at the window's current size: the fonts are
 * in, and the root's layout and every region, row, chart and feed row hold
 * the same box for three frames running. A resize redraws in steps (the
 * layout, then each region measuring itself), so one frame is not enough.
 */
async function wallSettled(page: Page) {
  const settled = await page.evaluate(async () => {
    await document.fonts.ready;
    const shape = () => {
      const root = document.querySelector(".wall-root");
      const boxes = [...document.querySelectorAll(
        ".wall-root, [data-wall-strip], [data-wall-revenue], [data-wall-needs], [data-wall-sites], [data-wall-feed], [data-site-row], [data-site-chart], [data-feed-item], [data-wall-next], [data-wall-health-row], [data-wall-factory]",
      )].map((element) => {
        const box = element.getBoundingClientRect();
        return `${box.x},${box.y},${box.width},${box.height}`;
      });
      return `${innerWidth}x${innerHeight} ${root?.getAttribute("data-wall-layout")} ${boxes.join(";")}`;
    };
    let last = shape();
    for (let frame = 0, still = 0; frame < 300; frame += 1) {
      await new Promise(requestAnimationFrame);
      const next = shape();
      still = next === last ? still + 1 : 0;
      if (still === 3) return true;
      last = next;
    }
    return false;
  });
  expect(settled, "the Wall stopped moving within 300 frames of its resize").toBe(true);
}
