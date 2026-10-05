// D28's site rows (docs/25-the-wall.md § Site rows, bead `ro-trai.5`): one slim
// row per site, drawn from the synthetic Wall fixture.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor } from "./render";
import { describe, expect, it } from "vitest";
import type { Ga4RealtimePayload } from "@noticeos/contract";
import { NO_READS } from "@shared/connection-status";
import type { AssetCard, AttentionItem } from "@shared/wall";
import { COMFORTABLE_MAX_SITES, FOCUS_SITES, SiteRows, siteRowDensity } from "@/components/wall/SiteRows";
import { wallIssues } from "@/lib/wall-issues";
import type { WallPulseMetrics } from "@/lib/wall-counters";
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from "../e2e/wall-fixture";

const NOW = Date.parse(WALL_FIXTURE_NOW);
const HOUR = 3_600_000;

function draw(
  assets: AssetCard[],
  { attention = [], realtime = wallFixtureRealtime(), realtimeError = false, pulseMetrics }: {
    attention?: AttentionItem[];
    realtime?: Ga4RealtimePayload;
    realtimeError?: boolean;
    pulseMetrics?: WallPulseMetrics;
  } = {},
) {
  return render(
    <SiteRows
      assets={assets}
      pulseMetrics={pulseMetrics}
      issues={wallIssues({ assets, attention, connections: NO_READS, nowMs: NOW })}
      ga4Realtime={realtime}
      ga4RealtimeError={realtimeError}
      nowMs={NOW}
    />,
  ).container;
}

const row = (container: HTMLElement, id: string) => container.querySelector(`[data-site-row="${id}"]`)!;

describe("the site rows", () => {
  it("draws one row per site, in seed order, under headings computed from the data", () => {
    const data = wallFixturePayload();
    const container = draw(data.assets);
    expect([...container.querySelectorAll("[data-site-row]")].map((r) => r.getAttribute("data-site-row"))).toEqual(
      data.assets.map((asset) => asset.id),
    );
    const headings = [...container.querySelectorAll('[role="columnheader"]')].map((cell) => cell.textContent);
    // The weekday comes from the saved clock the hours were bucketed in.
    // "30 min" is the live figure's window, said once here (bead ro-trai.27).
    expect(headings).toEqual(["Site", "Live · 30 min", "Today vs last Tue", "4 weeks"]);
  });

  it("states live users, today's pace and four weeks without repeating the revenue widget", () => {
    const container = draw(wallFixturePayload().assets);
    const menus = row(container, "menus.example");
    expect(menus.querySelector("[data-live]")?.getAttribute("data-live")).toBe("fresh");
    // One clean figure in neutral ink (bead ro-trai.19), announced whole.
    const live = menus.querySelector("[data-live-count]")!;
    expect(live.getAttribute("data-value")).toBe("21");
    expect(live.textContent).toBe("21");
    expect(live.getAttribute("aria-label")).toBe("Live users: 21");
    expect(live.className).toContain("text-foreground");
    expect(menus.querySelector("[data-split-flap-counter]")).toBeNull();
    // Today solid over last week dashed, the hour still filling a breathing
    // now point, the pace % and the hours it compares (bead ro-trai.43).
    const today = menus.querySelector("[data-site-today]")!;
    expect(today.querySelector("[data-today]")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(today.querySelector("[data-last-week]")?.getAttribute("stroke-dasharray")).toMatch(/^[\d.]+ [\d.]+$/);
    expect(today.querySelector("[data-last-week]")?.getAttribute("data-chart-line")).toBe("ghost");
    expect(today.querySelector("[data-filling-hour] [data-chart-breathe]")).not.toBeNull();
    expect(today.textContent).toBe("6.9%to 12 PM");
    expect(today.querySelector('[aria-label*="6.9% ahead; completed hours"]')).not.toBeNull();
    // Ahead of last week is on pace (paceTone, operator 2026-09-23).
    expect(today.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("pace-on");
    // The last four weeks solid over the four before dashed (the charts'
    // comparison line), the same two spans' smaller change to their right, and the first
    // and last day under them (bead ro-trai.26).
    const weeks = menus.querySelector("[data-site-trend]")!;
    expect(weeks.querySelector("[data-trend-line]")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(weeks.querySelector("[data-prior-weeks]")?.getAttribute("data-chart-line")).toBe("ghost");
    expect(menus.querySelector("[data-site-week]")?.textContent).toBe("12%vs prior 4 wk");
    expect([...weeks.querySelectorAll("[data-site-weeks-axis] span")].map((end) => end.textContent)).toEqual(["Aug 25", "Sep 21"]);
    expect(container.querySelector("[data-site-money]")).toBeNull();
  });

  it("restores configured totals and lets each asset select different metrics or none", () => {
    const assets = wallFixturePayload().assets;
    const initial = draw(assets);
    const plate = row(initial, "plate.example");
    expect(plate.querySelector('[data-site-total="accounts"]')?.textContent).toBe("Accounts6,267");
    expect(plate.querySelector('[data-site-total="leads"]')?.textContent).toBe("Leads1,316");
    expect(plate.querySelector('[data-site-total="plansSaved"]')).toBeNull();
    expect(row(initial, "rates.example").querySelector("[data-site-totals]")).toBeNull();
    const changed = draw(assets, { pulseMetrics: { "plate.example": ["plansSaved"], "menus.example": [] } });
    expect(row(changed, "plate.example").querySelector('[data-site-total="plansSaved"]')?.textContent).toContain("41,280");
    expect(row(changed, "plate.example").querySelector('[data-site-total="accounts"]')).toBeNull();
    expect(row(changed, "menus.example").querySelector('[data-site-totals]')).toBeNull();
    const focus = draw(assets.slice(0, 1));
    expect(focus.querySelector('[data-site-totals="plate.example"]')).not.toBeNull();
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
    const totals = row(container, site.id).querySelector('[data-site-totals]')!;
    expect(totals.querySelector('[data-site-total="accounts"] dd')?.textContent).toBe("0");
    expect(totals.querySelector('[data-site-total="leads"] [data-age-glyph="stale"]')).not.toBeNull();
    expect(totals.querySelector('[data-site-total="missing"]')).toBeNull();
  });

  it("keeps a counter-only site's known health when its totals are hidden", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    const site = assets[0]!;
    site.pulseReceivedAt = null;
    site.activeUsers.series = [];
    site.dataSources = [];
    const container = draw(assets, { realtime: { ...wallFixtureRealtime(), assets: [] }, pulseMetrics: { [site.id]: [] } });
    const siteRow = row(container, site.id);
    expect(siteRow.querySelector('[data-site-health="healthy"]')).not.toBeNull();
    expect(siteRow.querySelector('[data-site-totals]')).toBeNull();
    expect(siteRow.querySelector('[data-site-waiting]')).toBeNull();
  });

  it("colours today's line, wash, now point and % in the pace's one step: amber a little behind, red far behind", () => {
    const realtime = wallFixtureRealtime();
    // Today's completed hours at a share of last week's same hours.
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
        asset.asset === "menus.example" ? atShare("menus.example", 0.75) : asset.asset === "plate.example" ? atShare("plate.example", 0.3) : asset,
      ),
    };
    const container = draw(wallFixturePayload().assets, { realtime: shaped });
    const steps = (id: string) =>
      [...row(container, id).querySelectorAll("[data-site-today] [data-tone]")].map((element) => element.getAttribute("data-tone"));
    // The chart (line, wash and now point share its ink) and the % chip.
    expect(steps("menus.example")).toEqual(["pace-behind", "pace-behind"]);
    expect(steps("plate.example")).toEqual(["pace-far-behind", "pace-far-behind"]);
    // A site too small for a verdict (bead ro-trai.43: under 100 of last
    // week's users in the hours so far) draws no step and no percent.
    expect(steps("areas.example")).toEqual(["neutral"]);
    expect(row(container, "areas.example").querySelector("[data-site-today]")?.textContent).toBe("to 12 PM");
    const chart = row(container, "menus.example").querySelector("[data-site-today] [data-site-chart]")!;
    expect(chart.className).toContain("data-[tone=pace-behind]:text-pace-behind");
    expect(chart.querySelector("[data-today]")?.getAttribute("class")).toContain("stroke-current");
    expect(chart.querySelector("[data-chart-area]")).not.toBeNull();
    expect(chart.querySelector("[data-filling-hour]")).not.toBeNull();
    // Never colour alone: the arrow and the number stay.
    const chip = row(container, "menus.example").querySelector("[data-site-today] span[aria-label]")!;
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.textContent).toMatch(/^\d+%$/);
    expect(chip.getAttribute("aria-label")).toMatch(/% behind; completed hours today vs last Tue$/);
    // The one-site tile reads the same step from the same derivation.
    const only = wallFixturePayload().assets.find((asset) => asset.id === "menus.example")!;
    const tile = draw([only], { realtime: shaped }).querySelector('[data-focus-tile="today"]')!;
    expect([...tile.querySelectorAll("[data-tone]")].map((element) => element.getAttribute("data-tone"))).toEqual([
      "pace-behind",
      "pace-behind",
    ]);
  });

  it("counts a changed live reading to its new value instead of jumping", async () => {
    const assets = wallFixturePayload().assets;
    const realtime = wallFixtureRealtime();
    const issues = wallIssues({ assets, attention: [], connections: NO_READS, nowMs: NOW });
    const at = (value: number): Ga4RealtimePayload => ({
      ...realtime,
      assets: realtime.assets.map((asset) => (asset.asset === "menus.example" && asset.status === "success" ? { ...asset, activeUsers30m: value } : asset)),
    });
    const { container, rerender } = render(<SiteRows assets={assets} issues={issues} ga4Realtime={at(21)} nowMs={NOW} />);
    rerender(<SiteRows assets={assets} issues={issues} ga4Realtime={at(121)} nowMs={NOW} />);
    const live = () => row(container, "menus.example").querySelector("[data-live-count]")!;
    // The whole new reading is announced at once; only the drawn figure counts.
    expect(live().getAttribute("aria-label")).toBe("Live users: 121");
    expect(live().getAttribute("data-value")).toBe("121");
    expect(Number(live().textContent)).toBeLessThan(121);
    await waitFor(() => expect(live().textContent).toBe("121"), { timeout: 5_000 });
  });

  it("dims a live reading older than three minutes beside a clock", () => {
    const container = draw(wallFixturePayload().assets);
    const plate = row(container, "plate.example").querySelector("[data-live]")!;
    expect(plate.getAttribute("data-live")).toBe("stale");
    expect(plate.querySelector("[data-live-count]")?.className).toContain("text-muted-foreground");
    expect(plate.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Reading out of date");
  });

  it("renders a failed first read as a dash, never a zero", () => {
    const live = row(draw(wallFixturePayload().assets, { realtime: failedFor("menus.example") }), "menus.example").querySelector("[data-live]")!;
    expect(live.getAttribute("data-live")).toBe("none");
    expect(live.textContent).toBe("—");
  });
});

// Bead ro-trai.27: the live figure is the last 30 minutes, labelled, over a
// minute pulse whose newest five bars are the 5-minute window.
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

describe("the minute pulse", () => {
  const pulse = (cell: Element) => cell.querySelector("[data-minute-pulse]")!;
  /** The cell's words, its thin spaces read as spaces. */
  const words = (cell: Element) => (cell.textContent ?? "").replace(/ /g, " ");
  const bars = (cell: Element, kind: "recent" | "earlier") => [...cell.querySelectorAll(`[data-minute-bar="${kind}"]`)];

  it("labels the figure as the last 30 minutes and draws each of them, the newest five bright beside their count", () => {
    const menus = row(draw(wallFixturePayload().assets), "menus.example").querySelector('[data-live="fresh"]')!;
    // The table's heading says "30 min" once; the cell's own words appear
    // only where there is no heading (hidden by the region's width, which
    // jsdom does not lay out).
    expect(words(menus)).toBe("21 · 30 min7 · 5 min");
    expect(menus.querySelector("[data-live-unit]")?.className).toContain("sites:hidden");
    expect(pulse(menus).getAttribute("data-minute-pulse")).toBe("live");
    expect(pulse(menus).getAttribute("class")).toContain("text-traffic");
    expect(bars(menus, "recent")).toHaveLength(5);
    expect(bars(menus, "earlier")).toHaveLength(25);
    // Oldest on the left: the bars' values are the reading's own minutes.
    const snapshot = wallFixtureRealtime().assets.find((asset) => asset.asset === "menus.example");
    if (snapshot?.status !== "success") throw new Error("expected a reading");
    expect([...bars(menus, "earlier"), ...bars(menus, "recent")].map((bar) => Number(bar.getAttribute("data-value")))).toEqual(
      snapshot.activeUsersByMinute,
    );
    // The bright end is full ink; the rest keep a share of it.
    expect(bars(menus, "recent").every((bar) => bar.getAttribute("stroke-opacity") === "1")).toBe(true);
    expect(bars(menus, "earlier").every((bar) => Number(bar.getAttribute("stroke-opacity")) < 1)).toBe(true);
    expect(menus.querySelector("[data-live-recent-count]")?.getAttribute("data-value")).toBe("7");
  });

  it("draws a quiet minute as a tick on the floor and an unread one as nothing", () => {
    const realtime = wallFixtureRealtime();
    const shaped: Ga4RealtimePayload = {
      ...realtime,
      assets: realtime.assets.map((asset) =>
        asset.asset === "menus.example" && asset.status === "success"
          ? { ...asset, activeUsersByMinute: [...Array.from({ length: 27 }, (_, minute) => (minute % 3 === 0 ? 0 : 4)), 6, null, null] }
          : asset,
      ),
    };
    const menus = row(draw(wallFixturePayload().assets, { realtime: shaped }), "menus.example");
    expect(pulse(menus).getAttribute("data-unread-minutes")).toBe("2");
    expect(menus.querySelectorAll("[data-minute-bar]")).toHaveLength(28);
    const heights = [...menus.querySelectorAll("[data-minute-bar]")].map((bar) => {
      const [, y] = /V([\d.]+)$/.exec(bar.getAttribute("d")!)!;
      return 14 - Number(y);
    });
    // A quiet minute is a tick; a minute with anyone in it stands clear of it.
    expect(heights[0]).toBe(1.5);
    expect(heights[1]).toBeGreaterThan(2.5);
    expect(heights.at(-1)).toBe(14);
  });

  it("dims a stale reading's pulse with its age, the minutes since it unread", () => {
    const plate = row(draw(wallFixturePayload().assets), "plate.example").querySelector("[data-live]")!;
    expect(plate.getAttribute("data-live")).toBe("stale");
    expect(pulse(plate).getAttribute("data-minute-pulse")).toBe("dimmed");
    expect(pulse(plate).getAttribute("class")).toContain("text-muted-foreground");
    // Read twenty minutes before now and served in the minute before this
    // one: the nineteen minutes since were never read, so the bright end is
    // empty rather than zero.
    expect(pulse(plate).getAttribute("data-unread-minutes")).toBe("19");
    expect(bars(plate, "recent")).toHaveLength(0);
    // The age takes the 5-minute count's place: an old reading's last five
    // minutes are not the last five minutes.
    expect(plate.querySelector("[data-live-age]")?.textContent).toBe("20m");
    expect(plate.querySelector("[data-live-recent-count]")).toBeNull();
  });

  it("keeps the last pulse, dimmed with its age, when a later read fails — never zeros", () => {
    const assets = wallFixturePayload().assets;
    const issues = wallIssues({ assets, attention: [], connections: NO_READS, nowMs: NOW });
    const good = wallFixtureRealtime();
    const { container, rerender } = render(<SiteRows assets={assets} issues={issues} ga4Realtime={good} nowMs={NOW} />);
    const later = NOW + 4 * 60_000;
    rerender(<SiteRows assets={assets} issues={issues} ga4Realtime={failedFor("menus.example", good)} nowMs={later} />);
    const menus = row(container, "menus.example").querySelector("[data-live]")!;
    expect(menus.getAttribute("data-live")).toBe("failed");
    expect(menus.querySelector("[data-live-count]")?.getAttribute("data-value")).toBe("21");
    expect(pulse(menus).getAttribute("data-minute-pulse")).toBe("dimmed");
    expect(menus.querySelectorAll("[data-minute-bar]")).toHaveLength(30);
    // The age of the reading drawn, named by what went wrong.
    expect(menus.querySelector("[data-live-age]")?.textContent).toBe("4m");
    expect(menus.querySelector('[data-live-age] svg[role="img"]')?.getAttribute("aria-label")).toBe("Google rate limit");
    // A good read comes back: fresh again.
    rerender(<SiteRows assets={assets} issues={issues} ga4Realtime={good} nowMs={NOW} />);
    expect(row(container, "menus.example").querySelector("[data-live]")?.getAttribute("data-live")).toBe("fresh");
  });

  it("draws a dash for a site without GA4, whatever the payload holds", () => {
    const assets = wallFixturePayload().assets.map((asset) =>
      asset.id === "menus.example" ? { ...asset, dataSources: asset.dataSources.filter((source) => source.id !== "ga4") } : asset,
    );
    const menus = row(draw(assets), "menus.example").querySelector("[data-live]")!;
    expect(menus.getAttribute("data-live")).toBe("none");
    expect(menus.textContent).toBe("—");
    expect(menus.querySelector("[data-minute-pulse]")).toBeNull();
  });

  it("stands without a pulse when the minutes were refused: the figures stay", () => {
    const realtime = wallFixtureRealtime();
    const refused: Ga4RealtimePayload = {
      ...realtime,
      assets: realtime.assets.map((asset) => (asset.status === "success" ? { ...asset, activeUsersByMinute: null } : asset)),
    };
    const menus = row(draw(wallFixturePayload().assets, { realtime: refused }), "menus.example").querySelector("[data-live]")!;
    expect(menus.getAttribute("data-live")).toBe("fresh");
    expect(menus.querySelector("[data-minute-pulse]")).toBeNull();
    expect(words(menus)).toBe("21 · 30 min7 · 5 min");
  });

  it("is drawn at each tier's size: compact rows, roomier rows and the one-site tile", () => {
    const assets = wallFixturePayload().assets;
    const width = (container: HTMLElement, id: string) => Number(row(container, id).querySelector("[data-minute-pulse]")?.getAttribute("width"));
    expect(width(draw(assets), "menus.example")).toBe(119);
    // A roomier row's is as wide, and taller: its charts leave it no width.
    expect(width(draw(assets.slice(0, 3)), "menus.example")).toBe(119);
    expect(Number(row(draw(assets.slice(0, 3)), "menus.example").querySelector("[data-minute-pulse]")?.getAttribute("height"))).toBe(28);
    const tile = draw([assets.find((asset) => asset.id === "menus.example")!]).querySelector('[data-focus-tile="today"]')!;
    expect(Number(tile.querySelector("[data-minute-pulse]")?.getAttribute("width"))).toBe(238);
    // No heading over the tile: the figure says its window itself.
    expect(words(tile.querySelector('[data-focus-figure="live"]')!)).toBe("21 · 30 min7 · 5 min");
    expect(tile.querySelector("[data-live-unit]")?.className).not.toContain("sites:hidden");
  });
});

describe("the site rows", () => {
  it("takes the trend colour away from a change whose span crosses a reporting-timezone change", () => {
    const data = wallFixturePayload();
    const menus = data.assets.find((asset) => asset.id === "menus.example")!;
    const moved: AssetCard = {
      ...menus,
      activeUsers: {
        ...menus.activeUsers,
        timeZoneChanges: [{ effectiveOn: "2026-09-15", from: "America/Los_Angeles", to: "America/New_York" }],
      },
    };
    const others = data.assets.filter((asset) => asset.id !== "menus.example");
    const clean = row(draw([menus, ...others]), "menus.example").querySelector("[data-site-trend] [data-tone]")!;
    const spanned = row(draw([moved, ...others]), "menus.example").querySelector("[data-site-trend] [data-tone]")!;
    expect(clean.getAttribute("data-tone")).toBe("positive");
    expect(spanned.getAttribute("data-tone")).toBe("neutral");
    // The number stays; only the verdict goes.
    expect(spanned.textContent).toBe(clean.textContent);
    // One site shown in depth reads the same weekly change the same way.
    const alone = (asset: AssetCard) =>
      draw([asset]).querySelector('[data-focus-tile="visitors"] [data-site-week] [data-tone]')!.getAttribute("data-tone");
    expect([alone(menus), alone(moved)]).toEqual(["negative", "neutral"]);
  });
});

describe("a site's signal-bar health indicator", () => {
  it("shows distinct levels for healthy, warning and unknown sites beside their names", () => {
    const data = wallFixturePayload();
    const container = draw(data.assets, { attention: data.attention });
    for (const [id, state, bars] of [["menus.example", "healthy", 4], ["plate.example", "warn", 2], ["standards.example", "unknown", 0]] as const) {
      const health = row(container, id).querySelector('[data-site-name] [data-site-health]')!;
      expect(health.getAttribute("data-site-health")).toBe(state);
      expect(health.querySelectorAll('.opacity-100')).toHaveLength(bars);
      expect(health.getAttribute("aria-label")).toMatch(/^Site health:/);
    }
    expect(container.querySelector('[data-site-mark]')).toBeNull();
  });

  it("uses the most severe issue and names the remaining issues accessibly", () => {
    const data = wallFixturePayload();
    const [plansLow] = data.attention;
    const down = {
      ...plansLow!, id: 9102, severity: "error" as const, ruleId: "hygiene-home-unreachable", metric: "home",
      ruleInputs: { http_status: 503 }, firstFiredAt: new Date(NOW - 20 * 60_000).toISOString(),
    };
    const mark = row(draw(data.assets, { attention: [plansLow!, down] }), "plate.example").querySelector("[data-site-health]")!;
    expect(mark.getAttribute("data-site-health")).toBe("error");
    expect(mark.getAttribute("aria-label")).toBe("Site health: Home page down; 1 more issue");
    expect(mark.querySelectorAll('.opacity-100')).toHaveLength(1);
  });

  it("never marks a site that declared it sends no nightly report for a missing one (D29)", () => {
    const data = wallFixturePayload();
    const assets = data.assets.map((asset) =>
      asset.id === "rates.example" ? { ...asset, noNightlyReport: true, pulseReceivedAt: new Date(NOW - 9 * 24 * HOUR).toISOString() } : asset,
    );
    const stale = {
      ...data.attention[0]!, id: 9103, asset: "rates.example", assetDisplayName: "Rate Codes", ruleId: "ingest-freshness",
      metric: "pulse", ruleInputs: { state: "stale", ageHours: 216, thresholdHours: 48 },
    };
    expect(row(draw(assets, { attention: [stale] }), "rates.example").querySelector("[data-site-health]")?.getAttribute("data-site-health")).toBe("healthy");
  });
});

describe("rows without data yet", () => {
  it("are one quiet line, the same whether or not the site declared it sends no report", () => {
    const container = draw(wallFixturePayload().assets);
    const waiting = row(container, "standards.example");
    expect(waiting.getAttribute("data-site-state")).toBe("waiting");
    // A site that has never sent a report expects none (D29 amended,
    // ro-ujb9.121), so nothing is being waited for.
    expect(waiting.textContent).toBe("StandardsNo data yet");
    const declared = { ...wallFixturePayload().assets.find((asset) => asset.id === "standards.example")!, noNightlyReport: true };
    expect(row(draw([declared]), "standards.example").textContent).toBe("StandardsNo data yet");
  });
});

describe("any number of sites", () => {
  it("draws twelve sites as twelve rows of the same shape", () => {
    const [template] = wallFixturePayload().assets;
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      ...template!,
      id: `site-${index + 1}.example`,
      displayName: `Site ${index + 1}`,
    }));
    const container = draw(twelve);
    const rows = [...container.querySelectorAll("[data-site-row]")];
    expect(rows.map((r) => r.querySelector("[data-site-label]")?.textContent)).toEqual(twelve.map((site) => site.displayName));
    expect(new Set(rows.map((r) => r.getAttribute("data-site-density")))).toEqual(new Set(["compact"]));
  });

  it("keeps every site's complete name without truncating row content", () => {
    const assets = wallFixturePayload().assets;
    const container = draw(assets);
    expect(container.querySelector("[data-site-row] .truncate")).toBeNull();
    expect([...container.querySelectorAll("[data-site-label]")].map(element => element.textContent)).toEqual(assets.map(asset => asset.displayName));
    // Names can wrap; numeric figures retain their own column and shape.
  });
});

// docs/25-the-wall.md § Density, bead `ro-trai.13`.
describe("the density tiers", () => {
  const density = (container: HTMLElement) => container.querySelector("[data-wall-sites]")?.getAttribute("data-site-density");

  it("are chosen by the number of sites alone: one in depth, two or three roomier, four and more compact", () => {
    expect([1, 2, 3, 4, 7, 12].map(siteRowDensity)).toEqual(["focus", "comfortable", "comfortable", "compact", "compact", "compact"]);
    expect([FOCUS_SITES, COMFORTABLE_MAX_SITES]).toEqual([1, 3]);
    // Nothing about the sites themselves moves the tier: the three healthiest
    // sites and the three quietest (one still waiting for its first report)
    // are drawn alike, and so is one site with data or without.
    const assets = wallFixturePayload().assets;
    expect(density(draw(assets.slice(0, 3)))).toBe("comfortable");
    expect(density(draw(assets.slice(-3)))).toBe("comfortable");
    expect(density(draw(assets.slice(0, 1)))).toBe("focus");
    expect(density(draw(assets.slice(-1)))).toBe("focus");
    expect(density(draw(assets.slice(0, 4)))).toBe("compact");
  });

  it("fills comfortable chart cells when no totals are selected", () => {
    const assets = wallFixturePayload().assets.slice(0, 3);
    const container = draw(assets, { pulseMetrics: Object.fromEntries(assets.map(asset => [asset.id, []])) });
    const rows = [...container.querySelectorAll("[data-site-row]")];
    expect(rows.map((r) => r.getAttribute("data-site-density"))).toEqual(["comfortable", "comfortable", "comfortable"]);
    // The same cells as a compact row: live, today, 30 days, money.
    const menus = row(container, "menus.example");
    expect(menus.querySelector("[data-live-count]")?.getAttribute("data-value")).toBe("21");
    expect(menus.querySelector("[data-site-today]")?.textContent).toBe("6.9%to 12 PM");
    expect(menus.querySelector("[data-site-money]")).toBeNull();
    // Both charts fill their cell: today over last week, and the four-week line.
    expect(menus.querySelector('[data-site-today] [data-site-chart="filling"] [data-today]')).not.toBeNull();
    expect(menus.querySelector('[data-site-trend] [data-site-chart="filling"] [data-trend-line]')).not.toBeNull();
    // A step larger: the live figure and the others.
    expect(menus.querySelector("[data-live-count]")?.className).toContain("text-[length:var(--text-wall-site-live)]");

    // The rows share the region; the table knows how many.
    const table = container.querySelector('[role="table"]') as HTMLElement;
    expect(table.style.getPropertyValue("--site-rows")).toBe("3");
    expect(table.className).toContain("sites:auto-rows-[minmax(min-content,1fr)]");
  });

  it("overlays today's pace and keeps the four-week comparison outside its plot", () => {
    const container = draw(wallFixturePayload().assets.slice(0, 3));
    const menus = row(container, "menus.example");
    expect(menus.querySelector('[data-site-today] [data-site-chart="row"] [data-today]')).not.toBeNull();
    expect(menus.querySelector('[data-site-trend] [data-site-chart="row"] [data-trend-line]')).not.toBeNull();
    expect(menus.querySelector('[data-site-today] [data-site-comparison]')?.textContent).toBe("6.9%");
    expect(menus.querySelector('[data-site-trend] [data-site-comparison]')?.textContent).toBe("12%vs prior 4 wk");
    expect(menus.querySelector('[data-site-total="itemsRated"]')?.textContent).toContain("13,904");
    expect(menus.querySelector('[data-site-today]')?.textContent).toBe("6.9%to 12 PM");
    expect(menus.querySelector('[data-live-count]')?.className).toContain("text-[length:var(--text-wall-site-live)]");
  });

  it("keeps multiple compact totals inside the name cell with every label", () => {
    const container = draw(wallFixturePayload().assets, { pulseMetrics: { "menus.example": ["itemsRated", "restaurants"] } });
    const menus = row(container, "menus.example"), totals = menus.querySelector('[data-site-totals]')!;
    expect(totals.closest('[role="cell"]')).toBe(menus.querySelector('[data-site-name]'));
    expect(totals.querySelector('[role="cell"]')).toBeNull();
    expect(totals.textContent).not.toContain("Current catalog");
    expect(totals.querySelector('[data-site-total="itemsRated"]')?.textContent).toContain("13,904");
    expect(totals.querySelector('[data-site-total="restaurants"]')?.textContent).toContain("1,286");
    expect(totals.textContent).toContain("Items rated");
    expect(totals.textContent).toContain("Restaurants");
  });

  it("lets compact rows grow their charts and type with the available room", () => {
    const container = draw(wallFixturePayload().assets);
    const menus = row(container, "menus.example");
    expect(menus.querySelector('[data-site-chart="row"]')?.className).toContain("flex-1");
    // The four-week line before its small comparison %, in the traffic colour.
    expect(menus.querySelector('[data-site-trend] [data-site-chart="row"]')?.className).toContain("text-traffic");
    expect(menus.querySelector("[data-site-trend] [data-trend-line]")).not.toBeNull();
    // A step under the TV's stat size since the minute pulse sits under it
    // (bead ro-trai.27): the row keeps its 56 px floor and the column its width.
    expect(menus.querySelector("[data-live-count]")?.className).toContain("text-[length:var(--text-wall-site-live)]");
    expect(menus.querySelector("[data-live-count]")?.className).not.toContain("text-wall-hero-sm");

    expect((container.querySelector('[role="table"]') as HTMLElement).style.getPropertyValue("--site-rows")).toBe("6");
  });
});

describe("one site, in depth", () => {
  const withSearch = (asset: AssetCard): AssetCard => ({ ...asset, searchClicks: asset.activeUsers });
  const tiles = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-focus-tile]")].map((tile) => tile.getAttribute("data-focus-tile"));

  it("names the site with its mark, then today, the month's visitors and money, and search", () => {
    const data = wallFixturePayload();
    const only = withSearch(data.assets[0]!);
    const container = draw([only], { attention: data.attention });
    expect(container.querySelector("[data-site-header]")).toBeNull();
    const header = row(container, "plate.example");
    expect(header.querySelector("[data-site-label]")?.textContent).toBe("Plate Planner");
    expect(header.querySelector("[data-site-health]")?.getAttribute("aria-label")).toBe("Site health: Plans saved low");
    expect(tiles(container)).toEqual(["today", "visitors", "search"]);

    const today = container.querySelector('[data-focus-tile="today"]')!;
    expect(today.querySelector("h3")?.textContent).toBe("Today vs last Tue");
    expect(today.querySelector("[data-live-count]")?.getAttribute("data-value")).toBe("50");
    expect(today.querySelector('[data-focus-figure="today"]')?.textContent).toBe(`${only.activeUsers.series.at(-1)!.v}today`);
    expect(today.querySelector("[data-last-week]")?.getAttribute("data-chart-line")).toBe("ghost");
    expect(today.querySelector("[data-filling-hour]")?.getAttribute("data-chart-dot")).toBe("solid");

    const visitors = container.querySelector('[data-focus-tile="visitors"]')!;
    expect(visitors.querySelector("h3")?.textContent).toBe("Visitors and money · September");
    expect(visitors.querySelector('[data-focus-figure="per-thousand"]')?.textContent).toMatch(/^\$\d+\.\d\dper 1,000 visitors Sep 21$/);
    // The month so far: Sep 1 to today, today still being counted.
    expect(visitors.querySelectorAll("[data-visitors-bar]")).toHaveLength(22);
    expect(visitors.querySelectorAll('[data-visitors-bar="provisional"]')).toHaveLength(1);
    // The day still counted is hatched, never a short solid bar.
    expect(visitors.querySelector('[data-visitors-bar="provisional"]')?.className).toContain("chart-bar-provisional");
    expect(visitors.querySelector("[data-money-line]")).not.toBeNull();

    const search = container.querySelector('[data-focus-tile="search"]')!;
    expect(search.querySelector('[data-focus-figure="clicks"]')?.textContent).toMatch(/clicks Sep 21$/);
    expect(search.querySelector("[data-site-week]")).not.toBeNull();
  });

  it("leaves out a tile whose data the site lacks, and the others take its width", () => {
    const [only] = wallFixturePayload().assets;
    // The committed fixture has no search source.
    const noSearch = draw([only!]);
    expect(tiles(noSearch)).toEqual(["today", "visitors"]);
    expect(noSearch.querySelector('[data-focus-tile="search"]')).toBeNull();
    // No empty placeholder stands in: each tile present carries its own share.
    for (const tile of noSearch.querySelectorAll("[data-focus-tile]")) expect(tile.className).toMatch(/sites:flex-\[/);

    const realtime = wallFixtureRealtime();
    const noHours: Ga4RealtimePayload = {
      ...realtime,
      assets: realtime.assets.map((asset) => (asset.status === "success" ? { ...asset, hourlyActiveUsers: null } : asset)),
    };
    expect(tiles(draw([withSearch(only!)], { realtime: noHours }))).toEqual(["visitors", "search"]);
  });

  it("is the site's own row when there is nothing to show in depth yet", () => {
    const waiting = wallFixturePayload().assets.find((asset) => asset.id === "standards.example")!;
    const container = draw([waiting]);
    expect(container.querySelector("[data-focus-tile]")).toBeNull();
    expect(row(container, "standards.example").textContent).toBe("StandardsNo data yet");
  });
});

// Bead ro-trai.18: the site region is its own container. In D28's arrangement
// it is one track of a column beside the feed — about 1,380 px of a 1920 TV but
// about 670 px of a 1440 window — so its table must switch on the REGION's
// width. Keyed on the Wall's `xl:`, the table asked for ~950 px of columns in
// 670 px and its figures ran over each other and under the feed. jsdom has no
// layout, so the pixels are the captures' (docs/artifacts/wall-build-2026-09-23/
// default/sites-*-1440.png); this pins the mechanism.
describe("the site region's own breakpoints", () => {
  const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8");
  const classesIn = (container: HTMLElement) =>
    [...container.querySelectorAll("*")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));

  it("declares the region a container with its own two steps", () => {
    expect(css).toMatch(/\[data-wall-sites\]\s*\{\s*container:\s*wall-sites\s*\/\s*inline-size;/);
    expect(css).toMatch(/@custom-variant sites \{\s*@container wall-sites \(width >= 64rem\)/);
    expect(css).toMatch(/@custom-variant sites-wide \{\s*@container wall-sites \(width >= 80rem\)/);
  });

  it.each([
    ["compact rows", 7],
    ["roomier rows", 3],
    ["one site in depth", 1],
  ])("keys the %s on the region, never on the Wall's width", (_tier, count) => {
    const assets = wallFixturePayload().assets.slice(0, count);
    const container = draw(assets);
    expect(container.querySelector("[data-wall-sites]")).not.toBeNull();
    const classes = classesIn(container);
    expect(classes.filter((name) => /^(?:2?xl|lg|md|sm):/.test(name))).toEqual([]);
    expect(classes.some((name) => name.startsWith("sites:"))).toBe(true);
  });
});


describe("saved site traffic without a current-day reading", () => {
  it.each(["absent", "failed", "previous-day"])("shows dated GA4 history when hourly observations are %s", mode => {
    const assets = structuredClone(wallFixturePayload().assets);
    const asset = assets.find(site => site.id === "menus.example")!;
    asset.activeUsers = { series: [{ t: "2026-09-18", v: 17 }, { t: "2026-09-20", v: 0 }, { t: "2026-09-22", v: 50 }], provisionalFrom: "2026-09-22", collectedAt: "2026-09-21T06:00:00Z", timeZoneChanges: [] };
    const realtime = mode === "failed" ? failedFor(asset.id) : wallFixtureRealtime();
    const changed = { ...realtime, assets: mode === "absent" ? realtime.assets.filter(one => one.asset !== asset.id) : realtime.assets.map(one => one.asset === asset.id && one.status === "success" ? { ...one, hourlyObservedAt: "2026-09-21T12:00:00Z" } : one) };
    const container = draw(assets, { realtime: changed });
    const site = row(container, asset.id), history = site.querySelector('[data-site-history]')!;
    expect(history.getAttribute("data-date")).toBe("2026-09-20");
    expect(history.getAttribute("data-history-source")).toBe("ga4");
    expect(history.querySelector('time')?.getAttribute("dateTime")).toBe("2026-09-20");
    expect(history.textContent).toContain("Latest day · Sep 20");
    expect(history.textContent).toContain("0GA4 users");
    expect(history.querySelector('[aria-label="GA4 active users on 2026-09-20: 0"]')).not.toBeNull();
    expect(site.querySelector('[data-today]')).toBeNull();
    expect([...container.querySelectorAll('[role="columnheader"]')].map(cell => cell.textContent)).toContain("Today / latest day");
    if (mode !== "previous-day") expect(site.querySelector('[data-live]')?.textContent).toBe("—");
    // A neighboring current observation retains its hourly chart and pace.
    expect(row(container, "plate.example").querySelector('[data-today]')).not.toBeNull();
  });

  it("leaves the day unknown if there is no completed dated observation", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    const asset = assets[0]!;
    asset.activeUsers = { series: [{ t: "2026-09-22", v: 50 }], provisionalFrom: "2026-09-22", collectedAt: WALL_FIXTURE_NOW, timeZoneChanges: [] };
    const realtime = { ...wallFixtureRealtime(), assets: wallFixtureRealtime().assets.filter(one => one.asset !== asset.id) };
    const site = row(draw(assets, { realtime }), asset.id);
    expect(site.querySelector('[data-site-history]')).toBeNull();
    expect(site.querySelector('[data-site-today]')?.textContent).toBe("—");
    expect(site.querySelector('[data-live]')?.textContent).toBe("—");
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
      expect(label.className).toContain("wrap-anywhere");
      expect(site.querySelector('[data-site-health]')?.getAttribute('class')).toContain('shrink-0');
    }
  });
});
