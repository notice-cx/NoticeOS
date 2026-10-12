import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { render, screen } from "./render";
import { BarStrip, stripSummary } from "@/components/viz/BarStrip";
import { ageBuckets, ageLength, DecisionQueue } from "@/components/viz/DecisionQueue";
import { incidentGroup, IncidentList, rankIncidents } from "@/components/viz/IncidentList";
import { NormalBand, normalVerdict } from "@/components/viz/NormalBand";
import { PaceBar, paceSummary, paceVerdict } from "@/components/viz/PaceBar";
import { PortfolioRows, sourcesLive } from "@/components/viz/PortfolioRows";
import { StatTile } from "@/components/viz/StatTile";
import { formatInt, formatUsd } from "@/lib/format";

const NOW = Date.parse("2026-10-11T21:30:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("BarStrip", () => {
  const data = [
    { t: "2026-10-08", v: 10 },
    { t: "2026-10-09", v: null },
    { t: "2026-10-10", v: 0 },
    { t: "2026-10-11", v: 4 },
  ];

  it("highlights the newest settled day and never a day still being counted", () => {
    const { container } = render(<BarStrip data={data} tone="text-traffic" provisionalFrom="2026-10-11" ariaLabel="People a day" />);
    expect(container.querySelector('[data-bar="2026-10-10"]')?.getAttribute("data-state")).toBe("now");
    expect(container.querySelector('[data-bar="2026-10-11"]')?.getAttribute("data-state")).toBe("provisional");
  });

  it("keeps an unreported day apart from a measured zero", () => {
    const { container } = render(<BarStrip data={data} tone="text-traffic" ariaLabel="People a day" />);
    expect(container.querySelector('[data-bar="2026-10-09"]')?.getAttribute("data-state")).toBe("unreported");
    expect(container.querySelector('[data-bar="2026-10-10"]')?.getAttribute("data-state")).toBe("settled");
  });

  it("says its span, its highlighted day, its usual level and its gaps in words", () => {
    const words = stripSummary("People a day", data, data[3]!, { value: 7, label: "usual 7" }, formatInt);
    expect(words).toContain("People a day");
    expect(words).toContain("usual 7");
    expect(words).toContain("1 day not reported");
    expect(stripSummary("People a day", [], null, null, formatInt)).toBe("People a day: nothing reported yet");
  });
});

describe("PaceBar", () => {
  it("compares only against a last period it has", () => {
    expect(paceVerdict(364, null)).toBeNull();
    expect(paceVerdict(364, 0)).toBeNull();
    expect(paceVerdict(110, 100)).toEqual({ direction: "ahead", percent: 10 });
    expect(paceVerdict(90, 100)?.direction).toBe("behind");
    expect(paceVerdict(100.2, 100)?.direction).toBe("level");
  });

  it("names where the month is heading and last month's total, without a same-day figure it lacks", () => {
    const words = paceSummary({ value: 364, label: "Oct so far", previousAtSameDay: null, previousTotal: 1127, previousLabel: "Sep", projected: 1020, format: (n) => formatUsd(n) });
    expect(words).toBe("Oct so far $364; no Sep figure to compare; heading for $1,020; Sep total $1,127");
    render(<PaceBar value={364} label="Oct so far" previousAtSameDay={null} previousTotal={1127} previousLabel="Sep" projected={1020} tone="text-financial-revenue" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("heading for $1,020");
  });
});

describe("NormalBand", () => {
  it("judges a reading against its range", () => {
    expect(normalVerdict(1, 9, 17)).toBe("below");
    expect(normalVerdict(9, 9, 17)).toBe("within");
    expect(normalVerdict(18, 9, 17)).toBe("above");
  });

  it("paints only the bad side as a problem and always says the verdict in words", () => {
    const { container, rerender } = render(<NormalBand value={30} low={9} high={17} label="Requests" bad="below" />);
    expect(container.querySelector("[data-normal-band]")?.getAttribute("data-state")).toBe("normal");
    expect(screen.getByText("Above normal")).toBeTruthy();
    rerender(<NormalBand value={1} low={9} high={17} label="Requests" unit="a day" bad="below" severity="warn" />);
    expect(container.querySelector("[data-normal-band]")?.getAttribute("data-state")).toBe("warn");
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Requests: 1 a day, below normal; usual 9 to 17 a day");
  });
});

describe("StatTile", () => {
  it("names an absence instead of drawing a zero", () => {
    render(<StatTile label="Revenue, yesterday" value={null} absent="not reported yet" format={formatInt} />);
    expect(screen.getByText("not reported yet")).toBeTruthy();
  });

  it("withholds a verdict the two sides cannot support", () => {
    render(<StatTile label="Visitors, yesterday" value={3891} format={formatInt} comparison={{ percent: 4, change: 150, against: "vs last Sat", comparable: false }} />);
    expect(screen.getByText("not comparable vs last Sat")).toBeTruthy();
  });

  it("is one link when it opens something", () => {
    render(
      <MemoryRouter>
        <StatTile label="Revenue, yesterday" value={11.76} format={(n) => formatUsd(n, { cents: true })} to="/financials" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe("/financials");
    expect(screen.getByText("$11.76")).toBeTruthy();
  });
});

describe("DecisionQueue", () => {
  it("spreads the queue by age and leaves unknown ages out of the spread", () => {
    const buckets = ageBuckets([{ ageDays: 2 }, { ageDays: 7 }, { ageDays: 45 }, { ageDays: 61 }, { ageDays: null }]);
    expect(buckets.map((bucket) => [bucket.key, bucket.count])).toEqual([["fresh", 1], ["week", 1], ["month", 1], ["old", 1]]);
  });

  it("draws age so a two-day and a 67-day wait are both visible and plainly different", () => {
    expect(ageLength(0)).toBe(0);
    expect(ageLength(2)).toBeGreaterThan(0.15);
    expect(ageLength(67)).toBeGreaterThan(0.9);
    expect(ageLength(400)).toBe(1);
  });

  it("shows its size, the oldest wait and a few rows, with the rest one press away", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}`, kind: "approval" as const, title: `Item ${index}`, project: "Mosaic Finder", ageDays: index * 10 }));
    render(
      <MemoryRouter>
        <DecisionQueue items={items} total={147} limit={4} />
      </MemoryRouter>,
    );
    expect(screen.getByText("147")).toBeTruthy();
    expect(screen.getByText("50d", { selector: "b" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show 2 more" })).toBeTruthy();
  });
});

describe("IncidentList", () => {
  const marker = ago(20 * HOUR);
  it("groups by when it began against the last look, and folds what is over a week old", () => {
    expect(incidentGroup({ since: ago(37 * 60_000) }, NOW, marker)).toBe("new");
    expect(incidentGroup({ since: ago(30 * HOUR) }, NOW, marker)).toBe("open");
    expect(incidentGroup({ since: ago(67 * DAY) }, NOW, marker)).toBe("long-standing");
    expect(incidentGroup({ since: null }, NOW, marker)).toBe("open");
  });

  it("ranks errors first, then newest, unknown onsets last", () => {
    const ranked = rankIncidents([
      { key: "w", severity: "warn" as const, since: ago(HOUR) },
      { key: "e-old", severity: "error" as const, since: ago(5 * HOUR) },
      { key: "e-unknown", severity: "error" as const, since: null },
      { key: "e-new", severity: "error" as const, since: ago(HOUR) },
    ]);
    expect(ranked.map((item) => item.key)).toEqual(["e-new", "e-old", "e-unknown", "w"]);
  });

  it("names a long-standing problem in the folded line and counts what is broken", () => {
    render(
      <MemoryRouter>
        <IncidentList
          nowMs={NOW}
          marker={marker}
          items={[
            { key: "a", severity: "error", title: "Uptime collection failing", site: "Summit", since: ago(37 * 60_000) },
            { key: "b", severity: "error", title: "Home page check failed", site: "Summit", since: ago(67 * DAY) },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("2 broken")).toBeTruthy();
    expect(screen.getByRole("button", { expanded: false }).textContent).toContain("Home page check failed on Summit");
    expect(screen.getByLabelText("Summit · Uptime collection failing · since 37m ago")).toBeTruthy();
  });
});

describe("PortfolioRows", () => {
  it("counts live sources out of the ones a site owes", () => {
    expect(sourcesLive([
      { label: "Bing", state: "failing" },
      { label: "GA4", state: "working" },
      { label: "Clarity", state: "not-using" },
      { label: "PostHog", state: "collecting" },
      { label: "Uptime", state: "not-connected" },
    ])).toEqual({ live: 2, owed: 4, failing: 1 });
  });

  it("keeps every name whole and says what is missing", () => {
    render(
      <MemoryRouter>
        <PortfolioRows
          formatMoney={(n) => formatUsd(n, { cents: true })}
          rows={[{ id: "p", name: "Lantern Works", health: { word: "On track", tone: "quiet" }, people: [], peopleLatest: null, revenue: null, share: null, sources: [] }]}
        />
      </MemoryRouter>,
    );
    const name = screen.getByText("Lantern Works");
    expect(name.className).not.toContain("truncate");
    expect(name.getAttribute("title")).toBe("Lantern Works");
    expect(screen.getAllByText("no revenue").length).toBeGreaterThan(0);
  });

  it("dates every people line and names a failing source in words", () => {
    const people = Array.from({ length: 28 }, (_, i) => ({ t: new Date(Date.UTC(2026, 7, 26 + i)).toISOString().slice(0, 10), v: 100 + i }));
    const { container } = render(
      <MemoryRouter>
        <PortfolioRows
          formatMoney={(n) => formatUsd(n, { cents: true })}
          rows={[{
            id: "p", name: "Lantern Works", health: { word: "At risk", tone: "warn" }, people, peopleLatest: 127, peopleChange: 5.8,
            revenue: null, share: null,
            sources: [{ label: "Bing", state: "failing" }, { label: "GA4", state: "working" }, { label: "Uptime", state: "overdue" }],
          }]}
        />
      </MemoryRouter>,
    );
    const dates = [...container.querySelectorAll("[data-portfolio-dates]")].map((el) => el.textContent);
    expect(dates[0]).toBe("Aug 26Sep 22");
    expect(screen.getAllByRole("img", { name: "Lantern Works: people a day, Aug 26 to Sep 22" }).length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 3 data sources live; Bing failing, Uptime late")).toBeTruthy();
  });
});
