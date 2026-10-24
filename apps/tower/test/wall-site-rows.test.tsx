// Fixed-height portfolio metrics, drawn from the synthetic Wall fixture.

import { render, waitFor } from "./render";
import { describe, expect, it } from "vitest";
import type { Ga4RealtimePayload } from "@noticeos/contract";
import type { AssetCard } from "@shared/wall";
import { SiteRows } from "@/components/wall/SiteRows";
import { fourWeeks } from "@/lib/wall-sites";
import type { WallPulseMetrics } from "@/lib/wall-counters";
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from "../e2e/wall-fixture";

const NOW = Date.parse(WALL_FIXTURE_NOW);
const HOUR = 3_600_000;

function draw(
  assets: AssetCard[],
  { realtime = wallFixtureRealtime(), realtimeError = false, pulseMetrics, workAssets }: {
    realtime?: Ga4RealtimePayload;
    realtimeError?: boolean;
    pulseMetrics?: WallPulseMetrics;
    workAssets?: ReadonlySet<string>;
  } = {},
) {
  return render(
    <SiteRows
      assets={assets}
      pulseMetrics={pulseMetrics}
      workAssets={workAssets}

      ga4Realtime={realtime}
      ga4RealtimeError={realtimeError}
      nowMs={NOW}
    />,
  ).container;
}

const row = (container: HTMLElement, id: string) => container.querySelector(`[data-site-row="${id}"]`)!;

describe("the asset rows", () => {
  it.each([7, 0, null])("uses warning color only for a known positive blocked count (%s)", blocked => {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    if (blocked === null) asset.work = null;
    else asset.work!.blocked = blocked;
    const site = row(draw([asset]), asset.id);
    const value = site.querySelector('[data-site-work-blocked]')!;
    expect(value).toHaveTextContent(blocked === null ? "—" : String(blocked));
    if (blocked !== null && blocked > 0) expect(value.closest("dd")).toHaveClass("text-warn");
    else expect(value.closest("dd")).not.toHaveClass("text-warn");
  });
  it("colors a known positive four-week percentage green across a timezone move without changing the evidence", () => {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    const points = Array.from({ length: 56 }, (_, index) => ({ t: new Date(Date.UTC(2026, 6, 28 + index)).toISOString().slice(0, 10), v: index < 28 ? 100 : 123 }));
    asset.activeUsers = { ...asset.activeUsers, contextSeries: points.slice(0, 28), series: points.slice(28), provisionalFrom: null, timeZoneChanges: [{ effectiveOn: "2026-08-10", from: "America/New_York", to: "America/Los_Angeles" }] };
    expect(fourWeeks(asset.activeUsers)?.change).toEqual({ percent: 23, tone: "neutral" });
    const site = row(draw([asset]), asset.id);
    expect(site.querySelector('[data-site-week] [data-tone]')).toHaveAttribute("data-tone", "pace-on");
    expect(site.querySelector('[data-site-week]')).toHaveTextContent("23%");
    asset.activeUsers.contextSeries = [];
    const missing = row(draw([asset]), asset.id);
    expect(missing.querySelector('[data-site-week]')).toBeNull();
    expect(missing.querySelector('[data-site-trend]')).toHaveTextContent("Comparison unavailable");
  });

  it("places today's exact daily total before its pace and appends the reference day's daily total", () => {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    asset.activeUsers.series = [{ t: "2026-09-15", v: 123 }, { t: "2026-09-22", v: 456 }];
    const realtime = wallFixtureRealtime();
    realtime.assets = realtime.assets.map(snapshot => snapshot.status === "success" ? { ...snapshot, timeZone: "America/Los_Angeles" } : snapshot);
    const site = row(draw([asset], { realtime }), asset.id);
    const total = site.querySelector<HTMLElement>('[data-site-today-total]')!;
    expect(total).toHaveTextContent("456");
    expect(total).toHaveAccessibleName("456 daily active users today so far");
    const tile = total.closest(".wall-metric")!;
    expect(tile.querySelector(".wall-metric-context")).toHaveTextContent("vs last Tue 123");
    expect(tile.querySelector(".wall-metric-main")?.firstElementChild).toContainElement(total);
    expect(tile.querySelector(".wall-metric-secondary [data-site-today]")).not.toBeNull();
  });
  it("retains provider-day totals but suppresses a pace and chart whose calendar date differs", () => {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    asset.activeUsers.timeZone = "Pacific/Auckland";
    asset.activeUsers.series = [{ t: "2026-09-16", v: 11 }, { t: "2026-09-23", v: 22 }];
    const realtime = wallFixtureRealtime();
    realtime.assets = realtime.assets.map(snapshot => snapshot.status === "success" ? { ...snapshot, timeZone: "America/Los_Angeles" } : snapshot);
    const site = row(draw([asset], { realtime }), asset.id);
    expect(site.querySelector('[data-site-today-total]')).toHaveTextContent("22");
    expect(site.querySelector('[data-site-today-total]')?.closest(".wall-metric")?.querySelector(".wall-metric-context")).toHaveTextContent("vs last Wed 11");
    expect(site.querySelector('[data-site-today]')).toHaveTextContent("Comparison unavailable");
    expect(site.querySelector('[data-site-today-chart] svg')).toBeNull();
  });
  it("labels each asset's comparison weekday in its own reporting timezone", () => {
    const assets = structuredClone(wallFixturePayload().assets.slice(0, 2));
    assets[0]!.activeUsers.timeZone = "America/Los_Angeles";
    assets[1]!.activeUsers.timeZone = "Pacific/Auckland";
    const realtime = wallFixtureRealtime();
    realtime.assets = realtime.assets.filter(snapshot => assets.some(asset => asset.id === snapshot.asset)).map((snapshot, index) => snapshot.status === "success"
      ? { ...snapshot, timeZone: index === 0 ? "America/Los_Angeles" : "Pacific/Auckland", observedAt: WALL_FIXTURE_NOW, hourlyObservedAt: WALL_FIXTURE_NOW }
      : snapshot);
    // The same instant is Tuesday in Los Angeles and Wednesday in Auckland.
    const container = draw(assets, { realtime });
    const context = (asset: AssetCard) => row(container, asset.id).querySelector('[aria-label="Today"] .wall-metric-context');
    expect(context(assets[0]!)).toHaveTextContent("vs last Tue");
    expect(context(assets[1]!)).toHaveTextContent("vs last Wed");
  });

  it("draws one row per asset, in seed order, under headings computed from the data", () => {
    const data = wallFixturePayload();
    const container = draw(data.assets);
    expect([...container.querySelectorAll("[data-site-row]")].map((r) => r.getAttribute("data-site-row"))).toEqual(
      data.assets.map((asset) => asset.id),
    );
    expect(container.querySelector('h2')?.textContent).toBe('Portfolio');
    const titles = [...row(container, 'mosaic.example').querySelectorAll('.wall-metric-title')].map(tile => tile.firstElementChild?.nextSibling?.textContent);
    expect(titles).toEqual(['Momentum', 'Today', '4 weeks', 'Work', 'Product counts']);
    for (const tile of row(container, 'mosaic.example').querySelectorAll('.wall-metric-title')) expect(tile.querySelector('svg')).not.toBeNull();
  });

  it("states live users, today's pace and four weeks without repeating the revenue widget", () => {
    const container = draw(wallFixturePayload().assets);
    const mosaic = row(container, "mosaic.example");
    expect(mosaic.querySelector("[data-live]")?.getAttribute("data-live")).toBe("fresh");
    const live = mosaic.querySelector("[data-live-count]")!;
    expect(live.getAttribute("data-value")).toBe("21");
    expect(live.textContent).toBe("21");
    expect(live.getAttribute("aria-label")).toBe("Live users: 21");
    expect(live.className).toContain("text-foreground");
    expect(mosaic.querySelector("[data-split-flap-counter]")).toBeNull();
    const today = mosaic.querySelector("[data-site-today]")!.closest(".wall-metric")!;
    expect(today.querySelector("[data-today]")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(today.querySelector("[data-last-week]")?.getAttribute("stroke-dasharray")).toMatch(/^[\d.]+ [\d.]+$/);
    expect(today.querySelector("[data-last-week]")?.getAttribute("data-chart-line")).toBe("ghost");
    expect(today.querySelector("[data-filling-hour] [data-chart-breathe]")).not.toBeNull();
    expect(today.textContent).toContain("6.9%");
    expect(today.textContent).toContain("to 12 PM");
    expect(today.querySelector('[aria-label*="6.9% ahead; completed hours"]')).not.toBeNull();
    // Ahead of last week is on pace.
    expect(today.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("pace-on");
    const weeks = mosaic.querySelector("[data-site-trend]")!.closest(".wall-metric")!;
    expect(weeks.querySelector("[data-trend-line]")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(weeks.querySelector("[data-prior-weeks]")?.getAttribute("data-chart-line")).toBe("ghost");
    expect(mosaic.querySelector("[data-site-week]")?.textContent).toBe("12%");
    expect(weeks.querySelector(".wall-metric-main")).toHaveTextContent("12%vs prior 4 wk");
    expect([...weeks.querySelectorAll("[data-site-weeks-axis] span")].map((end) => end.textContent)).toEqual(["Aug 25", "Sep 21"]);
    expect(container.querySelector("[data-site-money]")).toBeNull();
  });

  it("restores configured totals and lets each asset select different metrics or none", () => {
    const assets = wallFixturePayload().assets;
    const initial = draw(assets);
    const plume = row(initial, "plume.example");
    expect(plume.querySelector('[data-site-total="accounts"]')?.textContent).toBe("6,267");
    expect(plume.querySelector('[data-site-total="leads"]')?.textContent).toBe("1,316");
    expect(plume.querySelector('[data-site-total="plansSaved"]')).toHaveTextContent("41,280");
    expect(row(initial, "ripple.example").querySelector("[data-site-totals]")).toBeNull();
    const changed = draw(assets, { pulseMetrics: { "plume.example": ["plansSaved"], "mosaic.example": [] } });
    expect(row(changed, "plume.example").querySelector('[data-site-total="plansSaved"]')?.textContent).toContain("41,280");
    expect(row(changed, "plume.example").querySelector('[data-site-total="accounts"]')).toBeNull();
    expect(row(changed, "mosaic.example").querySelector('[data-site-totals]')).toBeNull();
    const focus = draw(assets.slice(0, 1));
    expect(focus.querySelector('[data-site-totals="plume.example"]')).not.toBeNull();
  });

  it("shows a measured zero and a stale reading, but never invents a missing total", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    const site = assets[0]!;
    site.counters = {
      ...site.counters!, defaultMetrics: ["accounts", "leads", "missing"],
      cards: [
        { metric: "accounts", label: "Accounts", value: 0, observedAt: new Date(NOW).toISOString(), source: "counters" },
        { metric: "leads", label: "Leads", value: 17, observedAt: new Date(NOW - HOUR).toISOString(), source: "counters" },
        { metric: "missing", label: "Missing", value: null, observedAt: null, source: null },
      ],
    };
    const container = draw(assets);
    const totals = row(container, site.id).querySelector('.wall-product-counts')!;
    expect(totals.querySelector('[data-site-total="accounts"]')?.textContent).toBe("0");
    expect(totals.querySelector('[data-site-total="leads"] [data-age-glyph="stale"]')).not.toBeNull();
    expect(totals.querySelector('[data-site-total="missing"]')).toBeNull();
  });

  it("keeps a counter-only asset's identity when its totals are hidden", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    const site = assets[0]!;
    site.pulseReceivedAt = null;
    site.activeUsers.series = [];
    site.dataSources = [];
    const container = draw(assets, { realtime: { ...wallFixtureRealtime(), assets: [] }, pulseMetrics: { [site.id]: [] } });
    const siteRow = row(container, site.id);
    expect(siteRow.querySelector("[data-site-name]")?.textContent).toBe(site.displayName);
    expect(siteRow.querySelector('[data-site-totals]')).toBeNull();
    expect(siteRow.querySelector('[data-site-waiting]')).toBeNull();
  });

  it("uses the Wall traffic display bands consistently for today's chart and percentage", () => {
    const realtime = wallFixtureRealtime();
    const atShare = (asset: string, share: number): Ga4RealtimePayload["assets"][number] => {
      const snapshot = realtime.assets.find((one) => one.asset === asset)!;
      if (snapshot.status !== "success") return snapshot;
      return {
        ...snapshot,
        hourlyActiveUsers: snapshot.hourlyActiveUsers!.map((hour) =>
          hour.today === null ? hour : { ...hour, today: Math.round(hour.sameDayLastWeek * share) },
        ),
      };
    };
    const shaped: Ga4RealtimePayload = {
      ...realtime,
      assets: realtime.assets.map((asset) =>
        asset.asset === "mosaic.example" ? atShare("mosaic.example", 0.75) : asset.asset === "plume.example" ? atShare("plume.example", 0.3) : asset,
      ),
    };
    const container = draw(wallFixturePayload().assets, { realtime: shaped });
    const steps = (id: string) =>
      [...row(container, id).querySelectorAll("[data-site-today-chart][data-tone], [data-site-today] [data-tone]")].map((element) => element.getAttribute("data-tone"));
    expect(steps("mosaic.example")).toEqual(["wall-traffic-decline", "wall-traffic-decline"]);
    expect(steps("plume.example")).toEqual(["pace-far-behind", "pace-far-behind"]);
    // A site too small for a verdict (under 100 of last week's users in the
    // hours so far) draws no step and no percent.
    expect(steps("acorn.example")).toEqual(["neutral"]);
    expect(row(container, "acorn.example").querySelector("[data-site-today]")?.textContent).toBe("Gathering pace");
    const chart = row(container, "mosaic.example").querySelector("[data-site-today-chart]")!;
    expect(chart.className).toContain("data-[tone=wall-traffic-decline]:text-urgent");
    expect(chart.querySelector("[data-today]")?.getAttribute("class")).toContain("stroke-current");
    expect(chart.querySelector("[data-chart-area]")).not.toBeNull();
    expect(chart.querySelector("[data-filling-hour]")).not.toBeNull();
    const chip = row(container, "mosaic.example").querySelector("[data-site-today] span[aria-label]")!;
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.textContent).toMatch(/^\d+%$/);
    expect(chip.getAttribute("aria-label")).toMatch(/% behind; completed hours today vs last Tue$/);
    const only = wallFixturePayload().assets.find((asset) => asset.id === "mosaic.example")!;
    const tile = draw([only], { realtime: shaped }).querySelector('[data-site-today]')!.closest('.wall-metric')!;
    expect([...tile.querySelectorAll("[data-tone]")].map((element) => element.getAttribute("data-tone"))).toEqual([
      "wall-traffic-decline",
      "wall-traffic-decline",
    ]);
  });

  it("counts a changed live reading to its new value instead of jumping", async () => {
    const assets = wallFixturePayload().assets;
    const realtime = wallFixtureRealtime();
    const at = (value: number): Ga4RealtimePayload => ({
      ...realtime,
      assets: realtime.assets.map((asset) => (asset.asset === "mosaic.example" && asset.status === "success" ? { ...asset, activeUsers30m: value } : asset)),
    });
    const { container, rerender } = render(<SiteRows assets={assets} ga4Realtime={at(21)} nowMs={NOW} />);
    rerender(<SiteRows assets={assets} ga4Realtime={at(121)} nowMs={NOW} />);
    const live = () => row(container, "mosaic.example").querySelector("[data-live-count]")!;
    expect(live().getAttribute("aria-label")).toBe("Live users: 121");
    expect(live().getAttribute("data-value")).toBe("121");
    expect(Number(live().textContent)).toBeLessThan(121);
    await waitFor(() => expect(live().textContent).toBe("121"), { timeout: 5_000 });
  });

  it("dims a live reading older than three minutes beside a clock", () => {
    const container = draw(wallFixturePayload().assets);
    const plume = row(container, "plume.example").querySelector("[data-live]")!;
    expect(plume.getAttribute("data-live")).toBe("stale");
    expect(plume.querySelector("[data-live-count]")?.className).toContain("text-muted-foreground");
    expect(plume.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Reading out of date");
  });

  it("renders a failed first read as a dash, never a zero", () => {
    const live = row(draw(wallFixturePayload().assets, { realtime: failedFor("mosaic.example") }), "mosaic.example").querySelector("[data-live]")!;
    expect(live.getAttribute("data-live")).toBe("none");
    expect(live.querySelector('[aria-label="Unavailable"]')?.textContent).toBe("—");
  });
});

// The live figure is the last 30 minutes, labelled, over a minute pulse whose
// newest five bars are the 5-minute window.
const failedFor = (id: string, realtime = wallFixtureRealtime()): Ga4RealtimePayload => ({
  ...realtime,
  assets: realtime.assets.map((asset) =>
    asset.asset === id
      ? {
          asset: id, status: "error", activeUsers5m: null, activeUsers30m: null, hourlyActiveUsers: null,
          observedAt: new Date(NOW - 30_000).toISOString(), nextAttemptAt: new Date(NOW + 10 * 60_000).toISOString(),
          errorCode: "ga4_realtime_http_429", rateLimit: "hourly-tokens",
        }
      : asset,
  ),
});

describe("the asset rows", () => {
  it("keeps the visible trend direction color when its percentage spans a reporting-timezone change", () => {
    const data = wallFixturePayload();
    const mosaic = data.assets.find((asset) => asset.id === "mosaic.example")!;
    const moved: AssetCard = {
      ...mosaic,
      activeUsers: {
        ...mosaic.activeUsers,
        timeZoneChanges: [{ effectiveOn: "2026-09-15", from: "America/Los_Angeles", to: "America/New_York" }],
      },
    };
    const others = data.assets.filter((asset) => asset.id !== "mosaic.example");
    const clean = row(draw([mosaic, ...others]), "mosaic.example").querySelector("[data-site-trend] [data-tone]")!;
    const spanned = row(draw([moved, ...others]), "mosaic.example").querySelector("[data-site-trend] [data-tone]")!;
    expect(clean.getAttribute("data-tone")).toBe("pace-on");
    expect(spanned.getAttribute("data-tone")).toBe("pace-on");
    expect(spanned.textContent).toBe(clean.textContent);
    const alone = (asset: AssetCard) =>
      draw([asset]).querySelector('[data-site-trend] [data-site-week] [data-tone]')!.getAttribute("data-tone");
    expect([alone(mosaic), alone(moved)]).toEqual(["pace-on", "pace-on"]);
  });
});

describe("task-only asset identity", () => {
  it("keeps the icon and name when traffic, reports and counters are unavailable", () => {
    const asset = structuredClone(wallFixturePayload().assets.find(item => item.id === "mosaic.example")!);
    asset.pulseReceivedAt = null;
    asset.activeUsers = { ...asset.activeUsers, series: [], contextSeries: [] };
    delete asset.counters;
    const site = row(draw([asset], { realtime: { ...wallFixtureRealtime(), assets: [] } }), asset.id);
    expect(site.querySelector("[data-site-name]")?.textContent).toBe(asset.displayName);
    expect(site.querySelector("[data-site-work-open]")).toHaveTextContent(String(asset.work!.open + asset.work!.inProgress));
  });
});

describe("asset identity headers", () => {
  it("places the complete asset identity before its full-width metric group", () => {
    const asset = { ...wallFixturePayload().assets[0]!, displayName: "Example asset with a longer product name" };
    const site = row(draw([asset]), asset.id);
    expect(site.firstElementChild?.tagName).toBe("HEADER");
    expect(site.querySelector("h3")?.textContent).toBe(asset.displayName);
    expect(site.children[1]).toHaveClass("wall-portfolio-metrics");
    expect(site.querySelector("[data-site-health] rect")).toBeNull();
  });

  it("shows only the icon and asset name in headers, regardless of source or health state", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    for (const asset of assets) {
      const site = row(draw([asset]), asset.id);
      const header = site.querySelector("[data-site-name]")!;
      expect(header.textContent).toBe(asset.displayName);
      expect(header.children).toHaveLength(2);
      expect(header.querySelector("[data-site-health], [data-site-source], [data-site-waiting]")).toBeNull();
    }
  });
});

describe("rows without data yet", () => {
  it("are one quiet line, the same whether or not the asset declared it sends no report", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    assets.find(asset => asset.id === "summit.example")!.work = null;
    const container = draw(assets);
    const waiting = row(container, "summit.example");
    expect(waiting.querySelector("[data-site-waiting]")).toBeNull();
    // A site that has never sent a report expects none.
    expect(waiting.querySelector("[data-site-label]")?.textContent).toBe("Summit");
    expect(waiting.querySelector("[data-site-name]")?.textContent).toBe("Summit");
    expect(waiting.querySelector("[data-site-work-closed]")).toHaveTextContent("—");
    const declared = { ...assets.find((asset) => asset.id === "summit.example")!, noNightlyReport: true };
    expect(row(draw([declared]), "summit.example").querySelector("[data-site-name]")?.textContent).toBe("Summit");
  });
});

describe("any number of assets", () => {
  it("draws twelve assets as twelve rows of the same shape", () => {
    const [template] = wallFixturePayload().assets;
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      ...template!,
      id: `site-${index + 1}.example`,
      displayName: `Asset ${index + 1}`,
    }));
    const container = draw(twelve);
    const rows = [...container.querySelectorAll("[data-site-row]")];
    expect(rows.map((r) => r.querySelector("[data-site-label]")?.textContent)).toEqual(twelve.map((site) => site.displayName));
    expect(rows.every(r => r.classList.contains("wall-portfolio-row"))).toBe(true);
  });

  it("keeps every asset's complete name without truncating row content", () => {
    const assets = wallFixturePayload().assets;
    const container = draw(assets);
    expect(container.querySelector("[data-site-row] .truncate")).toBeNull();
    expect([...container.querySelectorAll("[data-site-label]")].map(element => element.textContent)).toEqual(assets.map(asset => asset.displayName));
  });
});

describe("saved asset traffic without a current-day reading", () => {
  it.each(["absent", "failed", "previous-day"])("keeps Today unknown rather than relabeling stale daily history when hourly observations are %s", mode => {
    const assets = structuredClone(wallFixturePayload().assets);
    const asset = assets.find(site => site.id === "mosaic.example")!;
    asset.activeUsers = { series: [{ t: "2026-09-18", v: 17 }, { t: "2026-09-20", v: 0 }, { t: "2026-09-21", v: 50 }], provisionalFrom: "2026-09-21", collectedAt: "2026-09-21T06:00:00Z", timeZoneChanges: [] };
    const realtime = mode === "failed" ? failedFor(asset.id) : wallFixtureRealtime();
    const changed = { ...realtime, assets: mode === "absent" ? realtime.assets.filter(one => one.asset !== asset.id) : realtime.assets.map(one => one.asset === asset.id && one.status === "success" ? { ...one, hourlyObservedAt: "2026-09-21T12:00:00Z" } : one) };
    const container = draw(assets, { realtime: changed });
    const site = row(container, asset.id), history = site.querySelector('[data-site-today]')!.closest('.wall-metric')!;
    expect(history.querySelector('h3')?.textContent).toContain('Today');
    expect(history.querySelector('[data-site-today-total]')?.textContent).toBe('—');
    expect(history.querySelector('[data-site-today-total]')).toHaveAccessibleName('Daily active users today unavailable');
    expect(site.querySelector('[data-today]')).toBeNull();
    if (mode !== "previous-day") expect(site.querySelector('[data-live] [aria-label="Unavailable"]')?.textContent).toBe("—");
    expect(row(container, "plume.example").querySelector('[data-today]')).not.toBeNull();
  });

  it("leaves the day unknown if there is no completed dated observation", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    const asset = assets[0]!;
    asset.activeUsers = { series: [{ t: "2026-09-22", v: 50 }], provisionalFrom: "2026-09-22", collectedAt: WALL_FIXTURE_NOW, timeZoneChanges: [] };
    const realtime = { ...wallFixtureRealtime(), assets: wallFixtureRealtime().assets.filter(one => one.asset !== asset.id) };
    const site = row(draw(assets, { realtime }), asset.id);
    expect(site.querySelector('[data-site-history]')).toBeNull();
    expect(site.querySelector('[data-site-today]')?.textContent).toBe("Comparison unavailable");
    expect(site.querySelector('[data-live] [aria-label="Unavailable"]')?.textContent).toBe("—");
  });

  it("wraps complete names while reserving the favicon and health mark", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    assets[0]!.displayName = "A Good Weeknight Dinner Planner";
    assets[1]!.displayName = "averylongunbrokenexamplename.example";
    const container = draw(assets);
    for (const asset of assets) {
      const site = row(container, asset.id), label = site.querySelector('[data-site-label]')!;
      expect(label.textContent).toBe(asset.displayName);
      expect(label.className).not.toContain("truncate");
      expect(label.className).toContain("wall-portfolio-name");
      expect(site.querySelector('.wall-portfolio-favicon')?.getAttribute('class')).toContain('shrink-0');
    }
  });
});


describe("fixed portfolio metrics", () => {
  it.each([1, 2, 3, 6, 12])("draws %s assets with the same row structure and complete identity", count => {
    const template = wallFixturePayload().assets[0]!;
    const assets = Array.from({ length: count }, (_, i) => ({ ...template, id: `asset-${i}.example`, displayName: `Asset ${i}` }));
    const container = draw(assets);
    expect(container.querySelectorAll('[data-site-row]')).toHaveLength(count);
    for (const asset of assets) {
      const site = row(container, asset.id);
      expect(site.querySelector('[data-site-label]')?.textContent).toBe(asset.displayName);
      expect(site.querySelector('[data-site-name]')?.textContent).toBe(asset.displayName);
      expect([...site.querySelectorAll('.wall-metric-title')].map(el => el.querySelector('span')?.textContent)).toEqual(['Momentum', 'Today', '4 weeks', 'Work', 'Product counts']);
      expect(site.querySelector('.wall-portfolio-metrics')?.lastElementChild).toHaveClass('wall-product-counts');
      for (const heading of site.querySelectorAll('.wall-metric-title')) expect(heading.querySelector('svg')).not.toBeNull();
    }
  });

  it("omits unselected product counts without leaving an empty tile", () => {
    const assets = wallFixturePayload().assets;
    const site = row(draw(assets, { pulseMetrics: { 'mosaic.example': [] } }), 'mosaic.example');
    expect(site.querySelector('.wall-product-counts')).toBeNull();
    expect(site.querySelectorAll('.wall-metric')).toHaveLength(4);
    expect(site.lastElementChild?.textContent).toContain('Work');
  });

  it("uses calendar-week closes and includes in-progress work once in Open", () => {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    asset.work = { ...asset.work!, open: 10, inProgress: 3, blocked: 4, closedRecent: 99, weeks: { ...asset.work!.weeks!, done: { ...asset.work!.weeks!.done, now: 7 } } };
    const site = row(draw([asset]), asset.id);
    expect(site.querySelector('[data-site-work-closed]')?.textContent).toBe('7');
    expect(site.querySelector('[data-site-work-open]')?.textContent).toBe('13');
    expect(site.querySelector('[data-site-work-blocked]')?.textContent).toBe('4');
  });

  it("keeps zero distinct from missing work and missing weekly history", () => {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    asset.work = { ...asset.work!, open: 0, inProgress: 0, blocked: 0, weeks: undefined };
    let site = row(draw([asset]), asset.id);
    expect(site.querySelector('[data-site-work-closed] [aria-label="Unavailable"]')).not.toBeNull();
    expect(site.querySelector('[data-site-work-open]')?.textContent).toBe('0');
    expect(site.querySelector('[data-site-work-blocked]')?.textContent).toBe('0');
    asset.work = null;
    site = row(draw([asset]), asset.id);
    expect(site.querySelectorAll('[data-site-work] [aria-label="Unavailable"]')).toHaveLength(3);
    expect(site.textContent).toContain('Tasks unavailable');
  });

  it("honors separate Work visibility without hiding the asset's traffic or product counts", () => {
    const assets = wallFixturePayload().assets;
    const container = draw(assets, { workAssets: new Set(['plume.example']) });
    expect(container.querySelectorAll('[data-site-row]')).toHaveLength(assets.length);
    expect(row(container, 'mosaic.example').querySelector('[data-site-work]')).toBeNull();
    expect(row(container, 'mosaic.example').querySelector('[data-live]')).not.toBeNull();
    expect(row(container, 'mosaic.example').querySelector('.wall-product-counts')).not.toBeNull();
    expect(row(container, 'plume.example').querySelector('[data-site-work]')).not.toBeNull();
  });

  it("keeps live zero, failed first reads and unavailable traffic history distinct", () => {
    const assets = wallFixturePayload().assets;
    const realtime = wallFixtureRealtime();
    const zero = { ...realtime, assets: realtime.assets.map(snapshot => snapshot.asset === 'mosaic.example' && snapshot.status === 'success' ? { ...snapshot, activeUsers30m: 0 } : snapshot) };
    expect(row(draw(assets, { realtime: zero }), 'mosaic.example').querySelector('[data-live-count]')?.textContent).toBe('0');
    const failed = row(draw(assets, { realtime: failedFor('mosaic.example') }), 'mosaic.example');
    expect(failed.querySelector('[data-live] [aria-label="Unavailable"]')).not.toBeNull();
    const empty = structuredClone(assets[0]!);
    empty.activeUsers = { ...empty.activeUsers, contextSeries: [], series: [] };
    const unknown = row(draw([empty], { realtime: { ...realtime, assets: [] } }), empty.id);
    expect(unknown.textContent).toContain('History unavailable');
    expect(unknown.querySelector('[data-trend-line]')).toBeNull();
  });
});


describe("minute momentum observations", () => {
  it("preserves all 30 minute buckets, their relative values and the newest five highlights", () => {
    const realtime = wallFixtureRealtime();
    const snapshot = realtime.assets.find(one => one.asset === 'mosaic.example');
    if (snapshot?.status !== 'success' || !snapshot.activeUsersByMinute) throw new Error('expected minute observations');
    const site = row(draw(wallFixturePayload().assets, { realtime }), 'mosaic.example');
    const bars = [...site.querySelectorAll('[data-metric-bar]')];
    const maximum = Math.max(1, ...snapshot.activeUsersByMinute.filter((value): value is number => value !== null));
    expect(bars).toHaveLength(30);
    bars.forEach((bar, i) => {
      const value = snapshot.activeUsersByMinute![i]!;
      expect(bar.getAttribute('data-metric-bar')).toBe(value === null ? 'missing' : i >= 25 ? 'recent' : 'earlier');
      expect((bar as HTMLElement).style.getPropertyValue('--metric-bar-height')).toBe(value === null ? '0%' : `${value / maximum * 100}%`);
    });
    expect(site.querySelector('[data-live-recent-count]')?.getAttribute('data-value')).toBe('7');
  });

  it("keeps unread minutes distinct from measured zero and dims stale buckets", () => {
    const assets = wallFixturePayload().assets;
    const realtime = wallFixtureRealtime();
    const shaped = { ...realtime, assets: realtime.assets.map(snapshot => snapshot.asset === 'mosaic.example' && snapshot.status === 'success' ? { ...snapshot, activeUsersByMinute: [0, 4, ...Array.from({ length: 28 }, () => null)] } : snapshot) };
    const fresh = row(draw(assets, { realtime: shaped }), 'mosaic.example');
    const buckets = [...fresh.querySelectorAll('[data-metric-bar]')];
    expect(buckets[0]).toHaveAttribute('data-metric-bar', 'earlier');
    expect(buckets[1]).toHaveAttribute('data-metric-bar', 'earlier');
    expect(buckets.filter(bar => bar.getAttribute('data-metric-bar') === 'missing')).toHaveLength(28);
    const stale = row(draw(assets), 'plume.example');
    expect(stale.querySelectorAll('[data-metric-bar="missing"]')).toHaveLength(19);
    expect(stale.querySelectorAll('[data-metric-bar="recent"]')).toHaveLength(0);
    expect(stale.querySelector('[data-live-age]')?.textContent).toBe('20m');
    expect(stale.querySelector('[data-live-recent-count]')).toBeNull();
  });

  it("retains the last usable numbers and minute buckets after a failed read", () => {
    const assets = wallFixturePayload().assets;
    const good = wallFixtureRealtime();
    const { container, rerender } = render(<SiteRows assets={assets} ga4Realtime={good} nowMs={NOW} />);
    rerender(<SiteRows assets={assets} ga4Realtime={failedFor('mosaic.example', good)} nowMs={NOW + 4 * 60_000} />);
    const site = row(container, 'mosaic.example');
    expect(site.querySelector('[data-live]')).toHaveAttribute('data-live', 'failed');
    expect(site.querySelector('[data-live-count]')).toHaveAttribute('data-value', '21');
    expect(site.querySelectorAll('[data-metric-bar]')).toHaveLength(30);
    expect(site.querySelectorAll('[data-metric-bar="recent"]')).toHaveLength(0);
    expect(site.querySelector('[data-live-age]')?.textContent).toBe('4m');
    expect(site.querySelector('[data-live-age] svg')).toHaveAccessibleName('Google rate limit');
  });
});
