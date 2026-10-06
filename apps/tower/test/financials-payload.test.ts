// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  PERIOD_PATTERN,
  type DomainOrder,
  type RecurringCost,
} from "../shared/financials";
import {
  PeriodNotFound,
  buildFinancialsPayload,
} from "../worker/financials-payload";
import { buildWallPayload } from "../worker/wall-payload";
import { createTestStore, type TestStore } from "./postgres-store";
import { bookLedger } from "./money";
import { addSites } from "./sites";

// The ledger is read from the call's store (bead ro-ujb9.76.6.1): each test
// writes its entries into its own copy of its sites (test/money.ts).

const NOW = new Date("2026-08-15T12:00:00.000Z");
/** The operator's clock these cases are written on (bead `ro-ujb9.88`),
 * stated rather than borrowed from the checkout's config/constants.json. */
const OS_TIME_ZONE = "America/Los_Angeles";

const DOMAINS: DomainOrder[] = [
  {
    domain: "nosh.example",
    asset: "nosh.example",
    kind: "registration",
    paidUsd: 109.69,
    paidOn: "2026-01-09",
  },
  {
    domain: "meals.example",
    asset: "meals.example",
    kind: "registration",
    paidUsd: 4.63,
    paidOn: "2026-03-18",
  },
];

let ctx: TestStore;

/** A site in both of the test's stores (test/sites.ts). */
async function asset(raw: TestStore, id: string, name: string, isOs = 0): Promise<void> {
  await addSites(raw, [{ id, domain: null, displayName: name, status: "live", senseOnly: 0, isOs, createdAt: "2026-01-01T00:00:00.000Z" }]);
}

async function ledger(row: {
  /** The fixture's name for the entry, for a correction's `supersedes`. */
  id?: number;
  kind: "revenue" | "cost";
  asset: string;
  period: string;
  family: string;
  minor: number;
  state?: "estimated" | "reconciled";
  source?: string | null;
  supersedes?: number;
  recordedAt?: string;
}): Promise<void> {
  await bookLedger(ctx.call, [
    {
      ...(row.id === undefined ? {} : { id: row.id }),
      kind: row.kind,
      asset: row.asset,
      period: row.period,
      family: row.family,
      amount_minor: row.minor,
      source: row.source ?? null,
      booking_state: row.state ?? "estimated",
      supersedes_id: row.supersedes ?? null,
      recorded_at: row.recordedAt ?? "2026-08-15T00:00:00.000Z",
    },
  ]);
}

beforeEach(async () => {
  ctx = await createTestStore();
  await asset(ctx, "meals.example", "Meal Planner");
  await asset(ctx, "nosh.example", "Nosh");
  // The OS row with the owner's pre-rename stored name (bead ro-ujb9.77.10).
  await asset(ctx, "root-os", "ReindexOS", 1);
});

describe("buildFinancialsPayload", () => {
  it('aligns selected-month daily reporting and current-month state to the reporting calendar', async () => {
    await ledger({ kind: 'revenue', asset: 'meals.example', period: '2026-09', family: 'ads', minor: 100 });
    const result = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: new Date('2026-10-01T01:00:00Z'), domainOrders: [], period: '2026-09' });
    expect(result.periodIsCurrent).toBe(true);
    expect(result.dailyRevenue).toMatchObject({ from: '2026-09-01', to: '2026-09-29', days: [] });
  });
  it("says so plainly when the ledger is empty", async () => {
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    expect(payload.empty).toBe(true);
    expect(payload.months).toEqual([]);
  });

  it("splits each month by booking state and never adds the two into net", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({
      kind: "revenue",
      asset: "meals.example",
      period: "2026-08",
      family: "ads",
      minor: 1000,
      state: "reconciled",
    });
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20000 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const august = payload.months.find((m) => m.period === "2026-08")!;
    expect(august.estimated.revenue).toBeCloseTo(440.94);
    expect(august.booked.revenue!).toBeCloseTo(10);
    // `total` is the shape of the month. The two sides remain separately
    // stated, so a reader can always see how much of it has settled.
    expect(august.total.revenue!).toBeCloseTo(450.94);
    expect(august.total.net!).toBeCloseTo(250.94);
  });

  /**
   * The page's central claim, and the reason it exists rather than a margin
   * column on the Wall: asset nets carry DIRECT costs only, overhead is its
   * own line, and the reader subtracts once. No allocation key appears anywhere.
   */
  it("keeps overhead out of every asset and reconciles the two tiers", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "meals.example", period: "2026-08", family: "api", minor: 305 });
    await ledger({ kind: "cost", asset: "nosh.example", period: "2026-08", family: "api", minor: 245 });
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20000 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const owned = payload.properties.filter((p) => !p.isOs);

    expect(owned.map((p) => p.asset)).toEqual(["meals.example", "nosh.example"]);
    expect(owned.find((p) => p.asset === "meals.example")!.figure.net!).toBeCloseTo(437.89);
    // Not one cent of the $200 overhead reached an asset.
    expect(owned.every((p) => p.figure.cost! < 100)).toBe(true);
    expect(payload.overhead.net!).toBeCloseTo(-200);

    // 437.89 − 2.45 = 435.44 of asset net, then the overhead subtracted
    // ONCE, visibly, which is the two-tier read this page is built around.
    const directNet = owned.reduce((sum, p) => sum + p.figure.net!, 0);
    expect(directNet).toBeCloseTo(435.44);
    expect(directNet + payload.overhead.net!).toBeCloseTo(235.44);
  });

  /**
   * The acceptance criterion that keeps this page from becoming a second truth:
   * it composes the same ledger the Wall does, so their portfolio totals must
   * agree to the cent.
   */
  it("agrees with the Wall's portfolio figure to the cent", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20000 });
    await ledger({ kind: "cost", asset: "nosh.example", period: "2026-08", family: "infra", minor: 914 });

    const financials = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const wall = await buildWallPayload(ctx.call, {
      now: NOW,
      constants: { dataUsd: 25 },
      integrations: { catalog: [], assets: {} },
      pullConfig: [],
      dashboard: {},
      serpPanel: { assets: {} },
      osTimeZone: OS_TIME_ZONE,
    } as unknown as Parameters<typeof buildWallPayload>[1]);

    const august = financials.months.find((m) => m.period === "2026-08")!;
    expect(august.estimated.net).toBeCloseTo(wall.portfolio.forecast.net!);
    expect(august.booked.net!).toBeCloseTo(wall.portfolio.booked.net!);
  });

  it("classifies each cost line by how it was learned, not just its family", async () => {
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20000, source: "recurring:claude-code" });
    await ledger({ kind: "cost", asset: "meals.example", period: "2026-08", family: "api", minor: 305, source: "metered:dataforseo" });
    await ledger({ kind: "cost", asset: "meals.example", period: "2026-08", family: "infra", minor: 215, source: "domains" });
    await ledger({ kind: "cost", asset: "meals.example", period: "2026-08", family: "inference", minor: 310, source: null });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const byProvenance = Object.fromEntries(
      payload.costLines.map((line) => [line.provenance, line.amount]),
    );
    expect(byProvenance.stated).toBeCloseTo(200);
    expect(byProvenance.metered).toBeCloseTo(3.05);
    expect(byProvenance.amortized).toBeCloseTo(2.15);
    // A legacy row with no source is shown as itself. Folding it into a
    // neighbour is how a total quietly stops adding up.
    expect(byProvenance.unclassified).toBeCloseTo(3.1);
  });

  it("spreads a domain order across the twelve months it covers", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 100 });
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: DOMAINS });

    const nom = payload.domains.find((d) => d.domain === "nosh.example")!;
    expect(nom.perMonth).toBeCloseTo(9.14);
    expect(nom.firstPeriod).toBe("2026-01");
    // Bought in January, so the term runs to December — not into next year.
    expect(nom.lastPeriod).toBe("2026-12");

    const meals = payload.domains.find((d) => d.domain === "meals.example")!;
    expect(meals.firstPeriod).toBe("2026-03");
    // March + 11 crosses the year boundary.
    expect(meals.lastPeriod).toBe("2027-02");

    // Most expensive first: the operator is looking for what to question.
    expect(payload.domains[0]!.domain).toBe("nosh.example");
  });

  /**
   * THE ROWS THE PAGE EDITS, VERBATIM AND IN FILE ORDER (bead `ro-x5gu.2`).
   *
   * Every other array on this payload is derived and sorted for reading. These
   * two may not be: the collection editor on /financials addresses an array row
   * by its INDEX (`/costs/0`) and guards the write with the row itself, so a
   * convenience sort here would silently point a Save at a different
   * subscription. `domains` above is sorted most-expensive-first from the SAME
   * input, which is exactly the pair this asserts cannot be confused.
   */
  it("carries both cost registers verbatim, in file order, for the page to edit", async () => {
    const RECURRING: RecurringCost[] = [
      {
        id: "claude-code",
        label: "Claude Code (Max)",
        asset: "root-os",
        family: "inference",
        amountUsdPerMonth: 200,
        from: "2026-06",
        note: "Portfolio overhead.",
      },
      { id: "cloudflare", label: "Cloudflare", asset: "root-os", family: "infra", amountUsdPerMonth: 5, from: "2026-06" },
    ];
    // Cheapest FIRST in the file, so the sorted view below cannot agree with
    // file order by accident.
    const ORDERS: DomainOrder[] = [DOMAINS[1]!, DOMAINS[0]!];
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 100 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE,
      now: NOW,
      domainOrders: ORDERS,
      recurringCosts: RECURRING,
    });

    // Byte-for-byte what the file holds — no derived field added, nothing
    // dropped, and the optional `to` still absent rather than written as null.
    expect(payload.recurringCosts).toEqual(RECURRING);
    expect(payload.domainOrders).toEqual(ORDERS);
    // File order, and provably NOT the sorted view built from the same rows.
    expect(payload.domainOrders.map((o) => o.domain)).toEqual(["meals.example", "nosh.example"]);
    expect(payload.domains.map((d) => d.domain)).toEqual(["nosh.example", "meals.example"]);
    expect(payload.domainOrders[0]).not.toHaveProperty("perMonth");
  });

  /** A register nobody injected is an empty list — "no subscription declared"
   * is a real state, and the page says so rather than failing to render. */
  it("treats an absent recurring-cost register as an empty list", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 100 });
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    expect(payload.recurringCosts).toEqual([]);
    expect(payload.domainOrders).toEqual([]);
  });

  /**
   * WHAT THE PAGE DOES NOT KNOW, AS DATA (bead `ro-ujb9.96.6.9`). A sum of no
   * revenue rows and a sum of a $0.00 row are both 0, so the one thing the
   * monthly figures cannot keep — whether anything reported at all — travels as
   * a flag the row draws as a dash. It replaced three paragraphs of prose the
   * payload used to ship as `gaps`.
   */
  it("says which assets reported any revenue in the month, apart from the amount", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "revenue", asset: "nosh.example", period: "2026-08", family: "ads", minor: 0 });
    await ledger({ kind: "cost", asset: "nosh.example", period: "2026-08", family: "infra", minor: 914 });
    await asset(ctx, "areas.example", "areas.example");
    await ledger({ kind: "cost", asset: "areas.example", period: "2026-08", family: "infra", minor: 92 });
    // A revenue row in ANOTHER month says nothing about this one.
    await ledger({ kind: "revenue", asset: "areas.example", period: "2026-07", family: "ads", minor: 50 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: DOMAINS });
    const reported = Object.fromEntries(payload.properties.map((p) => [p.asset, p.revenueReported]));
    expect(reported).toEqual({ "meals.example": true, "nosh.example": true, "areas.example": false });
    // A reported zero is still a zero, never the "not reported" dash.
    expect(payload.properties.find((p) => p.asset === "nosh.example")!.figure.revenue!).toBe(0);
    // No prose rides the payload any more.
    expect(payload).not.toHaveProperty("gaps");
  });

  /**
   * A restated figure is a NEW row superseding the old one, so counting both
   * would double the month the day it reconciles.
   */
  it("ignores a superseded estimate", async () => {
    await ledger({ id: 1, kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 45000, state: "reconciled",
      supersedes: 1, recordedAt: "2026-08-20T00:00:00.000Z" });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const august = payload.months.find((m) => m.period === "2026-08")!;
    expect(august.booked.revenue!).toBeCloseTo(450);
    expect(august.estimated.revenue).toBe(0);
    expect(august.total.revenue!).toBeCloseTo(450);
  });
});

/**
 * WHICH MONTH THE PAGE DESCRIBES (bead `ro-69vb`).
 *
 * The by-asset, cost and portfolio-net blocks used to read the current calendar
 * month and nothing else. Every row in this ledger lands by import or by hand,
 * so the first days of a month hold none: on 2026-09-04 all three printed $0.00
 * directly under a trajectory table showing August at +$200.25, and no month but
 * the live one could be looked at at all.
 */
describe("buildFinancialsPayload — the period it describes", () => {
  /** A day inside a month the seeded ledger below has no row for. */
  const SEPTEMBER = new Date("2026-09-04T12:00:00.000Z");

  async function seedThreeMonths(): Promise<void> {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({
      kind: "cost",
      asset: "root-os",
      period: "2026-08",
      family: "inference",
      minor: 20000,
      source: "recurring:claude-code",
    });
  }

  it("falls back to the latest month with rows rather than an empty current one", async () => {
    await seedThreeMonths();
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });

    expect(payload.period).toBe("2026-08");
    expect(payload.periodIsCurrent).toBe(false);
    // The defect itself: three blocks reading $0.00 under a table full of money.
    expect(
      payload.properties.find((p) => p.asset === "meals.example")!.figure.revenue!,
    ).toBeCloseTo(440.94);
    expect(payload.costLines).not.toHaveLength(0);
  });

  it("stays on the current month the moment it holds one row", async () => {
    await seedThreeMonths();
    await ledger({ kind: "cost", asset: "nosh.example", period: "2026-09", family: "infra", minor: 914 });
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });

    expect(payload.period).toBe("2026-09");
    expect(payload.periodIsCurrent).toBe(true);
  });

  it("lists every period the ledger holds a current row for, ascending", async () => {
    await seedThreeMonths();
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });

    expect(payload.periods).toEqual(["2026-06", "2026-07", "2026-08"]);
    // Same rows, same predicate as the trajectory table — the selector can
    // never offer a month that table does not have.
    expect(payload.periods).toEqual(payload.months.map((month) => month.period));
  });

  it("describes the month the reader asked for, not the latest one", async () => {
    await seedThreeMonths();
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE,
      now: SEPTEMBER,
      domainOrders: [],
      period: "2026-07",
    });

    expect(payload.period).toBe("2026-07");
    expect(payload.periodIsCurrent).toBe(false);
    expect(
      payload.properties.find((p) => p.asset === "meals.example")!.figure.revenue!,
    ).toBeCloseTo(200);
    // The trajectory table is unchanged by the choice: it is the whole ledger.
    expect(payload.months).toHaveLength(3);
  });

  /**
   * A month the ledger has nothing for is a MISS, never a quiet redirect to a
   * neighbour: figures for a period nobody asked for, under the URL that asked
   * for one, is the same lie this bead exists to remove.
   */
  it("refuses a month it has no rows for and hands back the ones it has", async () => {
    await seedThreeMonths();
    const thrown = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE,
      now: SEPTEMBER,
      domainOrders: [],
      period: "2026-01",
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(PeriodNotFound);
    expect((thrown as PeriodNotFound).periods).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("offers nothing to pick from when the ledger is empty", async () => {
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });

    expect(payload.empty).toBe(true);
    expect(payload.periods).toEqual([]);
    // Nothing to fall back to, so the clock is all that is left — and the page
    // renders its empty state rather than any of this.
    expect(payload.period).toBe("2026-09");
    expect(payload.periodIsCurrent).toBe(true);
  });

  // On D1 only a store the operator had not migrated past the ledger guards
  // (db/0036) could hold a correction in ANOTHER month, which is what left a
  // month with no current row. The Postgres store refuses that correction in
  // every workspace (0001_baseline.sql `ledger_correction_matches_target`), and
  // the importer refuses such a D1 pair by name, so no month is ever emptied.
  it("never holds a correction in another month, so no month is left with only a superseded row", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ id: 7, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", minor: 100 });
    await expect(
      ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 100, state: "reconciled", supersedes: 7 }),
    ).rejects.toThrow(/same site, month, kind, family and currency/);

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    expect(payload.periods).toEqual(["2026-07", "2026-08"]);
  });

  // The route checks the shape before it touches the store, so a typo is a 400
  // rather than a query.
  it("recognises a period only in `YYYY-MM` with a real month number", () => {
    expect(PERIOD_PATTERN.test("2026-08")).toBe(true);
    expect(PERIOD_PATTERN.test("2026-12")).toBe(true);
    expect(PERIOD_PATTERN.test("2026-13")).toBe(false);
    expect(PERIOD_PATTERN.test("2026-00")).toBe(false);
    expect(PERIOD_PATTERN.test("2026-8")).toBe(false);
    expect(PERIOD_PATTERN.test("2026-08-15")).toBe(false);
    expect(PERIOD_PATTERN.test("august")).toBe(false);
  });
});

/**
 * THE SHAPE BEHIND EACH ROW (bead `ro-78qo.29`).
 *
 * The by-asset table's share bar answers which asset is carrying THIS month.
 * Only a series answers which one is getting better, which is what doc 21 asks
 * a per-row sparkline for. These assert the two properties that make the line
 * trustworthy: it is the SAME arithmetic as the figure beside it, and it never
 * invents a month the ledger has no row for.
 */
describe("buildFinancialsPayload — each asset's own months", () => {
  const SEPTEMBER = new Date("2026-09-04T12:00:00.000Z");

  it("carries every month the asset has a row in, ascending, revenue minus direct cost", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "cost", asset: "meals.example", period: "2026-06", family: "api", minor: 500 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meals = payload.properties.find((p) => p.asset === "meals.example")!;

    expect(meals.months.map((month) => month.period)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(meals.months.map((month) => month.figure?.net ?? null)).toEqual([95, 200, 440.94]);
    // Revenue and cost travel with the net, so a hover on a point can name the
    // composition without a second request.
    expect(meals.months[0]!.figure).toEqual({ currency: 'USD', revenue: 100, cost: 5, net: 95 });
  });

  /**
   * ONE DERIVATION, NOT TWO. The figure the row prints and the point its line
   * ends on are the same grouping asked for the same month; the moment they
   * came off separate queries a row could print a net its own line disagreed
   * with.
   */
  it("makes the selected month's point the row's own figure", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "meals.example", period: "2026-08", family: "api", minor: 305 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE,
      now: SEPTEMBER,
      domainOrders: [],
      period: "2026-07",
    });
    const meals = payload.properties.find((p) => p.asset === "meals.example")!;

    // The table describes July, so July's point is the figure — and the series
    // still carries August, which the page slices off for itself.
    expect(meals.months.find((month) => month.period === "2026-07")!.figure).toEqual(
      meals.figure,
    );
    expect(meals.months.map((month) => month.period)).toEqual(["2026-07", "2026-08"]);
  });

  /**
   * A MONTH THE ASSET BOOKED NOTHING IN IS A HOLE ON ITS OWN AXIS (bead
   * `ro-78qo.37`) — present so a sparkline spaces the months correctly, null so
   * nothing reads a figure where there is none. A zero would be a figure nobody
   * booked; an omission would draw January next to June as though they were
   * neighbours.
   */
  it("fills a skipped month with a null rather than a figure or nothing", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meals = payload.properties.find((p) => p.asset === "meals.example")!;

    expect(meals.months).toEqual([
      { period: "2026-06", figure: { currency: 'USD', revenue: 100, cost: 0, net: 100 } },
      { period: "2026-07", figure: null },
      { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 0, net: 440.94 } },
    ]);
  });

  /**
   * THE AXIS IS THE ASSET'S, NOT THE LEDGER'S. An asset whose first row is
   * August has no June — prefixing one would invent a month it did not exist
   * in, which is a different mistake from the gap above. And a asset whose axis
   * merely SPANS the selected month with a hole in it is not a row of a table
   * describing that month.
   */
  it("starts each asset's axis at its own first row, and lists no asset whose selected month is a hole", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "nosh.example", period: "2026-08", family: "infra", minor: 914 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    expect(payload.properties.find((p) => p.asset === "nosh.example")!.months).toEqual([
      { period: "2026-08", figure: { currency: 'USD', revenue: 0, cost: 9.14, net: -9.14 } },
    ]);

    // July is a hole for Meal Planner and nosh.example has no July at all, so a table
    // describing July lists neither — and refuses the month rather than
    // printing an empty split under a real header.
    const july = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE,
      now: SEPTEMBER,
      domainOrders: [],
      period: "2026-07",
    }).then(
      (p) => p.properties,
      () => "refused" as const,
    );
    expect(july).toBe("refused");
  });

  /**
   * The page spends a whole section keeping "zero" apart from "not measured".
   * A month an asset holds no row for gets no figure, because a manufactured
   * run of zeroes would draw a cliff the ledger never recorded.
   */
  it("gives an asset no point for a month it has no row in", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "nosh.example", period: "2026-08", family: "infra", minor: 914 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const nom = payload.properties.find((p) => p.asset === "nosh.example")!;

    expect(nom.months.map((month) => month.period)).toEqual(["2026-08"]);
    // The ledger holds three months. Two of them are not nosh.example's to claim.
    expect(payload.periods).toHaveLength(3);
  });

  /** One month of history is one point, and the page draws a dash for it. */
  it("yields a one-point series from a single-month ledger", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meals = payload.properties.find((p) => p.asset === "meals.example")!;

    expect(meals.months).toEqual([
      { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 0, net: 440.94 } },
    ]);
  });

  /** The same superseded-row predicate as everything else on this payload: a
   * restatement must not double the month it restates. */
  it("excludes a superseded row from the series", async () => {
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ id: 1, kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 45000, state: "reconciled",
      supersedes: 1, recordedAt: "2026-08-20T00:00:00.000Z" });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meals = payload.properties.find((p) => p.asset === "meals.example")!;

    expect(meals.months.map((month) => month.figure?.net ?? null)).toEqual([200, 450]);
  });

  /** Asset #0 is a row of this grouping too — the overhead line — and it earns
   * the same history, so nothing here is special-cased on `is_os`. */
  it("gives the overhead asset its months as well", async () => {
    await ledger({ kind: "cost", asset: "root-os", period: "2026-07", family: "inference", minor: 20000 });
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20500 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const os = payload.properties.find((p) => p.isOs)!;

    expect(os.months.map((month) => month.figure?.net ?? null)).toEqual([-200, -205]);
    // Named by the product, never by what its row stores (bead ro-ujb9.77.10).
    expect(os.displayName).toBe("NoticeOS");
    expect(JSON.stringify(payload)).not.toContain("ReindexOS");
  });
});
