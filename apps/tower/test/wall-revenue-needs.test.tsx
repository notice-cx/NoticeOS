// The Wall's revenue and Needs attention widgets, drawn from the synthetic Wall fixture.

import { render, within } from "./render";
import { describe, expect, it } from "vitest";
import { NO_READS } from "@shared/connection-status";
import type { WallPayload } from "@shared/wall";
import type { WallLayout } from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";
import { NeedsYou } from "@/components/wall/NeedsYou";
import { RevenueHero } from "@/components/wall/RevenueHero";
import { wallIssues } from "@/lib/wall-issues";
import { WALL_FIXTURE_NOW, wallFixturePayload } from "../e2e/wall-fixture";

const NOW = Date.parse(WALL_FIXTURE_NOW);
const ZERO = { currency: 'USD', revenue: 0, cost: 0, net: 0 };

describe("the revenue widget", () => {
  it("leads with the month's revenue, where it lands, and the month against last month", () => {
    const data = wallFixturePayload();
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={NOW} />);
    const section = container.querySelector("[data-wall-revenue='pace']")!;
    expect(section).not.toBeNull();
    expect(section.querySelector('[data-metric-expanded]')).toHaveAttribute('data-metric-expanded', 'true');
    expect(section.querySelector(".wall-metric-plot [role='img']")).not.toBeNull();
    expect(within(section as HTMLElement).getByRole("heading").textContent).toBe("Revenue this monthUSD");
    expect(section.querySelector("[data-revenue-figure]")?.textContent).toBe("$1,185");
    // Plume Studio $1,310 + Mosaic Finder $385, the two ready projections.
    expect(section.querySelector("[data-revenue-pace]")?.textContent).toBe("$1,695");
    // Yesterday in place of the month's daily average: Plume Studio $43.18
    // + Mosaic Finder $12.07, both reports in.
    expect(section.querySelector('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday$55.25Sep 21 · Pacific · est.");
    expect(section.querySelector('[data-metric-fact="days left"]')?.textContent).toBe("days left9");
    expect(section.textContent).not.toContain("a day");
    expect(section.querySelector("[data-revenue-yesterday]")?.getAttribute("data-revenue-yesterday")).toBe("all");
    // Forecast comparisons name their basis alongside the performance color.
    const change = section.querySelector("[data-metric-movement]")!;
    expect(change.textContent).toContain("16% above");
    expect(change.textContent).toContain("projected vs Aug total");
    expect(change.getAttribute("data-tone")).toBe("positive");
    // Observed cumulative revenue, its forecast and the prior total share a scale.
    expect(section.querySelector('[data-metric-previous-total]')).not.toBeNull();
    expect(section.querySelector('[data-metric-cumulative-bar="current"]')).not.toBeNull();
    expect(section.querySelector('[data-metric-cumulative-bar="forecast"]')).not.toBeNull();
    expect(section.textContent).toContain('Aug total $1,458');
  });

  it("says \"so far\" in place of \"est.\" and \"estimated\" in the business words, and nothing else changes", () => {
    const data = wallFixturePayload();
    const draw = (wordLevel?: "business" | "operational" | "technical") => {
      const { container, unmount } = render(<RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={NOW} wordLevel={wordLevel} />);
      const section = container.querySelector<HTMLElement>("[data-wall-revenue]")!;
      const words = {
        heading: within(section).getByRole("heading").textContent,
        yesterday: section.querySelector('[data-metric-fact="Yesterday"]')?.textContent,
        text: section.textContent,
      };
      unmount();
      return words;
    };
    const business = draw("business");
    expect(business.heading).toBe("Revenue this monthUSD");
    expect(business.yesterday).toBe("Yesterday$55.25Sep 21 · Pacific · so far");
    expect(business.text).not.toMatch(/est\.|estimated/i);
    // The product and Everything words are the widget's own, unchanged.
    for (const level of [undefined, "operational", "technical"] as const) {
      expect(draw(level)).toEqual({
        heading: "Revenue this monthUSD",
        yesterday: "Yesterday$55.25Sep 21 · Pacific · est.",
        text: business.text!.replace("September · so far", "September · estimated").replace("Pacific · so far", "Pacific · est."),
      });
    }
  });

  it.each([
    [2, "50% below Aug"],
    [0.5, "100% above Aug"],
    [1, "0% level with Aug"],
  ] as const)("states a projection's direction against last month at ratio %s with a clearly labeled performance color", (previousFactor, label) => {
    const data = wallFixturePayload();
    const asset = data.assets.find((asset) => asset.revenueProjection?.status === "ready")!;
    const projection = asset.revenueProjection!;
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={[{
      ...asset,
      revenueProjection: { ...projection, previousMonthMinor: projection.projectedMinor! * previousFactor },
    }]} nowMs={NOW} />);
    const change = container.querySelector("[data-metric-movement]")!;
    expect(change.textContent).toContain(label.replace(" Aug", ""));
    expect(change.textContent).toContain("projected vs Aug total");
    expect(change).toHaveAttribute("data-tone", previousFactor > 1 ? "negative" : previousFactor < 1 ? "positive" : "neutral");
    expect(change).toHaveAccessibleName(`Projected revenue ${label} total`);
  });

  it("gives no comparison verdict without a complete prior revenue month", () => {
    const data = wallFixturePayload();
    const asset = data.assets.find((asset) => asset.revenueProjection?.status === "ready")!;
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={[{
      ...asset, revenueProjection: { ...asset.revenueProjection!, previousMonthMinor: null },
    }]} nowMs={NOW} />);
    expect(container.querySelector("[data-revenue-pace]")).not.toBeNull();
    expect(container.querySelector("[data-metric-movement]")).toBeNull();
  });

  it("reads the same for an installation with one asset", () => {
    const data = wallFixturePayload();
    const [only] = data.assets;
    const { container } = render(
      <RevenueHero
        portfolio={{ ...data.portfolio, forecast: { currency: 'USD', revenue: 924, cost: 0, net: 924 } }}
        assets={[only!]}
        nowMs={NOW}
      />,
    );
    // The one site's own projection: $924 so far, $1,310 at the month's end.
    expect(container.querySelector("[data-revenue-figure]")?.textContent).toBe("$924");
    expect(container.querySelector("[data-revenue-pace]")?.textContent).toBe("$1,310");
    // One site's yesterday is never "1 of 1".
    expect(container.querySelector('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday$43.18Sep 21 · Pacific · est.");
    expect(container.querySelector(".wall-metric-plot [role='img']")).toHaveAccessibleName(expect.stringContaining("forecast"));
  });

  it("says there is no revenue source in one line, with no chart", () => {
    const data = wallFixturePayload();
    const { container } = render(
      <RevenueHero
        portfolio={{ ...data.portfolio, forecast: ZERO, booked: ZERO, netTrend: [], firstRun: true }}
        assets={data.assets.map((asset) => ({ ...asset, revenueProjection: undefined }))}
      />,
    );
    const section = container.querySelector("[data-wall-revenue='none']")!;
    expect(section.textContent).toBe("No revenue source");
    expect(section.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".wall-metric-plot svg")).toBeNull();
  });
});

// Yesterday's revenue in the pace line: missing is not zero.
describe("yesterday on the revenue widget", () => {
  const withYesterday = (amounts: (number | null)[]) => {
    const data = wallFixturePayload();
    let next = 0;
    return {
      portfolio: data.portfolio,
      assets: data.assets.map((asset) =>
        asset.dailyRevenue ? { ...asset, dailyRevenue: { ...asset.dailyRevenue, amountMinor: amounts[next++] ?? null } } : asset,
      ),
    };
  };

  it("shows what is in and how many revenue assets it covers when a report is missing", () => {
    const { container } = render(<RevenueHero {...withYesterday([4_318, null])} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("some");
    // Two of the six sites have a revenue source; the other four are not owed.
    expect(container.querySelector("[data-wall-revenue]")?.textContent).toContain("Yesterday$43.18Sep 21 · Pacific · est. · 1 of 2 assets");
    // The figure is drawn as a figure; the words around it stay quiet.
    const figure = yesterday.querySelector("[data-revenue-yesterday-figure]")!;
    expect(figure.textContent).toBe("$43.18");
    expect(figure.closest('[data-metric-fact="Yesterday"]')).toHaveAttribute("data-fact-size", "figure");
  });

  it("states received reports with incompatible bases without inventing a total or missing reports", () => {
    const data = withYesterday([4_318, 1_207]);
    const sources = data.assets.filter(asset => asset.dailyRevenue);
    sources[1]!.dailyRevenue = { ...sources[1]!.dailyRevenue!, timeZone: "UTC" };
    const { container } = render(<RevenueHero {...data} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("mixed");
    expect(yesterday.closest('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday—Mixed report days · 2 of 2 assets · no total");
    expect(yesterday.querySelector("[data-revenue-yesterday-figure]")).toBeNull();
    expect(yesterday.textContent).not.toContain("not reported");
  });

  it("labels the actual received day when another clock's report is missing", () => {
    const data = withYesterday([4_318, null]);
    const sources = data.assets.filter(asset => asset.dailyRevenue);
    sources[1]!.dailyRevenue = { ...sources[1]!.dailyRevenue!, timeZone: "UTC" };
    const { container } = render(<RevenueHero {...data} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("some");
    expect(yesterday.closest('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday$43.18Sep 21 · Pacific · est. · 1 of 2 assets");
  });

  it("says so in words, with no number, before any report is in", () => {
    const { container } = render(<RevenueHero {...withYesterday([null, null])} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("none");
    expect(container.querySelector("[data-wall-revenue]")?.textContent).toContain("YesterdayNot reported yetSep 21 · Pacific");
    expect(yesterday.textContent).not.toMatch(/\$/);
  });

  it("states a recorded $0 as $0", () => {
    const { container } = render(<RevenueHero {...withYesterday([0, 0])} nowMs={NOW} />);
    expect(container.querySelector('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday$0.00Sep 21 · Pacific · est.");
  });

  it("still shows yesterday under the reason while the month has no pace yet", () => {
    const data = wallFixturePayload();
    const assets = data.assets.map((asset) =>
      asset.revenueProjection
        ? {
            ...asset,
            revenueProjection: {
              ...asset.revenueProjection,
              status: "insufficient-history" as const,
              reason: "Learning from traffic and revenue · 12/21 days.",
              projectedMinor: null,
              dailyPaceMinor: null,
              points: [],
            },
          }
        : asset,
    );
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={assets} nowMs={NOW} />);
    expect(container.querySelector("[data-wall-revenue]")?.getAttribute("data-wall-revenue")).toBe("figure");
    expect(container.querySelector("[data-revenue-waiting]")?.textContent).toBe("Learning from traffic and revenue · 12/21 days.");
    expect(container.querySelector('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday$55.25Sep 21 · Pacific · est.");
    expect(container.querySelector(".wall-metric-plot svg")).toBeNull();
  });
});

// A new installation's first three weeks: the revenue sites report daily, but
// no projection is ready and the ledger has no row yet.
describe("the revenue widget before the month has a pace or a ledger row", () => {
  const NO_LEDGER = { forecast: ZERO, booked: ZERO, netTrend: [], firstRun: true };
  const learningOnly = (earned: boolean) => {
    const data = wallFixturePayload();
    return {
      portfolio: { ...data.portfolio, ...NO_LEDGER },
      assets: data.assets.map((asset) =>
        asset.revenueProjection
          ? {
              ...asset,
              revenueProjection: {
                ...asset.revenueProjection,
                status: earned ? ("insufficient-history" as const) : ("waiting-revenue" as const),
                reason: earned ? "Learning from traffic and revenue · 12/21 days." : "Waiting for complete revenue reports.",
                earnedMinor: earned ? asset.revenueProjection.earnedMinor : null,
                projectedMinor: null,
                dailyPaceMinor: null,
                points: [],
              },
            }
          : asset,
      ),
    };
  };

  it("shows the month so far, the reason and yesterday, never 'No revenue source'", () => {
    const { container } = render(<RevenueHero {...learningOnly(true)} nowMs={NOW} />);
    const section = container.querySelector("[data-wall-revenue]")!;
    expect(section.getAttribute("data-wall-revenue")).toBe("figure");
    expect(section).not.toHaveClass("isolate");
    expect(section.textContent).not.toContain("No revenue source");
    expect(within(section as HTMLElement).getByRole("heading").textContent).toBe("Revenue this monthUSD");
    // Plume Studio $924 + Mosaic Finder $261 reported so far.
    expect(section.querySelector("[data-revenue-figure]")?.textContent).toBe("$1,185");
    expect(section.querySelector("[data-revenue-waiting]")?.textContent).toBe("Learning from traffic and revenue · 12/21 days.");
    expect(section.querySelector('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday$55.25Sep 21 · Pacific · est.");
    expect(section.querySelector(".wall-metric-plot svg")).toBeNull();
  });

  it("shows the reason and yesterday with no figure while no month is complete", () => {
    const { container } = render(<RevenueHero {...learningOnly(false)} nowMs={NOW} />);
    const section = container.querySelector("[data-wall-revenue]")!;
    expect(section.getAttribute("data-wall-revenue")).toBe("waiting");
    expect(section).not.toHaveClass("isolate");
    expect(section.querySelector("[data-revenue-figure]")).toBeNull();
    expect(section.querySelector("[data-revenue-waiting]")?.textContent).toBe("Waiting for complete revenue reports.");
    expect(section.querySelector('[data-metric-fact="Yesterday"]')?.textContent).toBe("Yesterday$55.25Sep 21 · Pacific · est.");
    expect(section.textContent).not.toContain("No revenue source");
  });
});

it('shows unknown current revenue with dated estimated history instead of a cost-only zero', () => {
  const data = wallFixturePayload();
  const assets = data.assets.filter(asset => asset.revenueProjection).map(asset => ({ ...asset, revenueProjection: { ...asset.revenueProjection!, earnedMinor: null } }));
  const { container } = render(<RevenueHero portfolio={{ ...data.portfolio, revenueRecorded: { booked: false, forecast: false }, forecast: { currency: 'USD', revenue: 0, cost: 35, net: -35 }, booked: ZERO }} assets={assets} nowMs={NOW} />);
  const section = container.querySelector('[data-wall-revenue="waiting"]')!;
  expect(section).not.toBeNull();
  expect(section.querySelector('[data-revenue-figure]')).toBeNull();
  expect(section.querySelector('[data-revenue-waiting]')).toHaveTextContent("Waiting for revenue reports.");
  expect(section.querySelector('[data-revenue-previous-month]')).toHaveTextContent('August 2026 $1,458 est.');
  expect(section.querySelector('[data-revenue-pace]')).toHaveTextContent('$');
});

it('names partial dated previous-month coverage without calling it a portfolio total', () => {
  const data = wallFixturePayload();
  const sources = data.assets.filter(asset => asset.revenueProjection);
  const assets = sources.map((asset, index) => ({ ...asset, revenueProjection: { ...asset.revenueProjection!, earnedMinor: null, previousMonthMinor: index === 0 ? 30000 : null } }));
  const { container } = render(<RevenueHero portfolio={{ ...data.portfolio, revenueRecorded: { booked: false, forecast: false }, forecast: { currency: 'USD', revenue: 0, cost: 35, net: -35 }, booked: ZERO }} assets={assets} nowMs={NOW} />);
  expect(container.querySelector('[data-revenue-figure]')).toBeNull();
  expect(container.querySelector('[data-revenue-previous-month]')).toHaveTextContent('August 2026 $300 est. · 1 of 2 assets');
  expect(container.querySelector('[data-metric-movement]')).toBeNull();
});

describe("Needs attention", () => {
  it("uses a base metric tile with prominent urgent tasks and a truthful decision total", () => {
    const { container } = render(<NeedsYou issues={[]} nowMs={NOW} operator={{ waiting: 12, urgent: 4, measuredProjects: 2, urgentMeasuredProjects: 2, projectCount: 2, capturedAt: new Date(NOW).toISOString() }} />);
    const tile = container.querySelector("[data-wall-needs]")!;
    expect(tile).toHaveClass("wall-metric");
    expect(tile.querySelector(".wall-metric-value")).toHaveTextContent("4");
    expect(tile).toHaveTextContent("4 urgent tasks");
    expect(tile).toHaveTextContent("Included in your 12 decisions");
    expect(tile.querySelector("[data-needs-calm]")).toHaveTextContent("Nothing broken");
    expect((tile as HTMLElement).style.height).toBe("");
  });

  it("is one calm line when nothing needs the operator", () => {
    const { container } = render(
      <NeedsYou
        issues={[]}
        operator={{ waiting: 0, urgent: 0, measuredProjects: 6, urgentMeasuredProjects: 6, projectCount: 6, capturedAt: new Date(NOW - 60_000).toISOString() }}
        nowMs={NOW}
      />,
    );
    const calm = container.querySelector("[data-needs-calm]")!;
    expect(calm.textContent).toBe("Nothing needs attention");
    expect(calm.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-needs-row]")).toBeNull();
    expect(container.querySelector("[data-needs-meta]")).toBeNull();
  });

  it("uses lower-bound words for urgent tasks in a partially read inbox", () => {
    const { container } = render(<NeedsYou issues={[]} nowMs={NOW}
      operator={{ waiting: 3, urgent: 1, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 2, capturedAt: new Date(NOW).toISOString() }} />);
    expect(container.querySelector("[data-needs-meta]")).toHaveTextContent("at least 1 urgent tasks");
    expect(container).not.toHaveTextContent("Nothing needs attention");
    expect(container).not.toHaveTextContent("Included in your");
  });

  it("lists the fixture's warning with its asset, sentence and age, and the urgent tasks beside the heading", () => {
    const data = wallFixturePayload();
    const { container } = render(
      <NeedsYou
        issues={wallIssues({ assets: data.assets, attention: data.attention, connections: NO_READS, nowMs: NOW })}
        operator={data.operator}
        nowMs={NOW}
      />,
    );
    const rows = container.querySelectorAll("[data-needs-row]");
    expect(rows).toHaveLength(1);
    expect(container.querySelector("[data-wall-needs]")).toHaveStyle({ height: "auto", overflow: "visible" });
    expect(rows[0]!.getAttribute("data-needs-row")).toBe("warn");
    expect(rows[0]!.textContent).toContain("Plume Studio");
    expect(rows[0]!.querySelector("[data-needs-line]")?.textContent).toMatch(/^Plans saved well below normal/);
    expect(rows[0]!.querySelector("[data-needs-age]")?.textContent).toBe("2h");
    expect(container.querySelector("[data-needs-meta]")?.textContent).toBe("1 of 1 · 1 urgent task");
  });

  it("never rotates: every row stays in place until it resolves", () => {
    const data = wallFixturePayload();
    const fire = [
      ...data.attention,
      { ...data.attention[0]!, id: 7001, severity: "error" as const, ruleId: "hygiene-home-unreachable", metric: "home", ruleInputs: { http_status: 503 }, asset: "acorn.example", assetDisplayName: "Acorn Atlas", firstFiredAt: new Date(NOW - 25 * 60_000).toISOString() },
      { ...data.attention[0]!, id: 7002, asset: "mosaic.example", assetDisplayName: "Mosaic Finder", firstFiredAt: new Date(NOW - 60 * 60_000).toISOString() },
      { ...data.attention[0]!, id: 7003, asset: "ripple.example", assetDisplayName: "Ripple Index", firstFiredAt: new Date(NOW - 30 * 60_000).toISOString() },
    ];
    const { container } = render(
      <NeedsYou issues={wallIssues({ assets: data.assets, attention: fire, connections: NO_READS, nowMs: NOW })} operator={data.operator} nowMs={NOW} />,
    );
    const sites = [...container.querySelectorAll("[data-needs-row]")].map((row) => row.querySelector("span")?.textContent);
    expect(sites).toEqual(["Acorn Atlas", "Ripple Index", "Mosaic Finder"]);
    expect(container.querySelector("[data-needs-meta]")?.textContent).toBe("3 of 4 · 1 urgent task");
    expect(container.querySelector("[data-attention-progress]")).toBeNull();
  });
});

describe("the Wall draws both from a layout", () => {
  it("places revenue and Needs attention in one row", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [
        { id: "body", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1.55 }, { id: "needs", type: "needs", width: 1 }] },
      ],
    };
    const data: WallPayload = wallFixturePayload();
    const { container } = render(<WallCanvas layout={layout} data={data} nowMs={NOW} />);
    const row = container.querySelector("[data-wall-row='body']")!;
    expect(row.querySelector("[data-wall-revenue]")).not.toBeNull();
    expect(row.querySelector("[data-wall-needs]")).not.toBeNull();
  });

  it("asks the revenue widget's yesterday on the Wall's own clock", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [{ id: "money", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1 }] }],
    };
    const data: WallPayload = wallFixturePayload();
    const yesterday = (nowMs: number) =>
      render(<WallCanvas layout={layout} data={data} nowMs={nowMs} />).container.querySelector('[data-metric-fact="Yesterday"]')?.textContent;
    expect(yesterday(NOW)).toBe("Yesterday$55.25Sep 21 · Pacific · est.");
    // A day later on the Wall's clock the held reports describe the day
    // before yesterday, so none of them is yesterday's.
    expect(yesterday(NOW + 86_400_000)).toBe("YesterdayNot reported yetSep 22 · Pacific");
  });
});
