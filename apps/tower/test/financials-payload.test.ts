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

// Each test writes its ledger entries into its own copy of its sites (test/money.ts).

const NOW = new Date("2026-08-15T12:00:00.000Z");
/** Stated rather than borrowed from the checkout's config/constants.json. */
const OS_TIME_ZONE = "America/Los_Angeles";

const DOMAINS: DomainOrder[] = [
  {
    domain: "northwind.example",
    asset: "northwind.example",
    kind: "registration",
    paidUsd: 109.69,
    paidOn: "2026-01-09",
  },
  {
    domain: "meadow.example",
    asset: "meadow.example",
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
  await asset(ctx, "meadow.example", "Meadow Board");
  await asset(ctx, "northwind.example", "Northwind");
  // The OS row with a stored name no payload shows.
  await asset(ctx, "root-os", "ReindexOS", 1);
});

describe("buildFinancialsPayload", () => {
  it('aligns selected-month daily reporting and current-month state to the reporting calendar', async () => {
    await ledger({ kind: 'revenue', asset: 'meadow.example', period: '2026-09', family: 'ads', minor: 100 });
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
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({
      kind: "revenue",
      asset: "meadow.example",
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
    expect(august.total.revenue!).toBeCloseTo(450.94);
    expect(august.total.net!).toBeCloseTo(250.94);
  });

  /** Asset nets carry direct costs only, overhead is its own line, and the
   * reader subtracts once. No allocation key appears anywhere. */
  it("keeps overhead out of every asset and reconciles the two tiers", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "meadow.example", period: "2026-08", family: "api", minor: 305 });
    await ledger({ kind: "cost", asset: "northwind.example", period: "2026-08", family: "api", minor: 245 });
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20000 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const owned = payload.properties.filter((p) => !p.isOs);

    expect(owned.map((p) => p.asset)).toEqual(["meadow.example", "northwind.example"]);
    expect(owned.find((p) => p.asset === "meadow.example")!.figure.net!).toBeCloseTo(437.89);
    expect(owned.every((p) => p.figure.cost! < 100)).toBe(true);
    expect(payload.overhead.net!).toBeCloseTo(-200);

    // 437.89 − 2.45 = 435.44 of asset net, then the overhead subtracted once.
    const directNet = owned.reduce((sum, p) => sum + p.figure.net!, 0);
    expect(directNet).toBeCloseTo(435.44);
    expect(directNet + payload.overhead.net!).toBeCloseTo(235.44);
  });

  /** The page composes the same ledger the Wall does, so their portfolio
   * totals must agree to the cent. */
  it("agrees with the Wall's portfolio figure to the cent", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20000 });
    await ledger({ kind: "cost", asset: "northwind.example", period: "2026-08", family: "infra", minor: 914 });

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
    await ledger({ kind: "cost", asset: "meadow.example", period: "2026-08", family: "api", minor: 305, source: "metered:dataforseo" });
    await ledger({ kind: "cost", asset: "meadow.example", period: "2026-08", family: "infra", minor: 215, source: "domains" });
    await ledger({ kind: "cost", asset: "meadow.example", period: "2026-08", family: "inference", minor: 310, source: null });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const byProvenance = Object.fromEntries(
      payload.costLines.map((line) => [line.provenance, line.amount]),
    );
    expect(byProvenance.stated).toBeCloseTo(200);
    expect(byProvenance.metered).toBeCloseTo(3.05);
    expect(byProvenance.amortized).toBeCloseTo(2.15);
    // A legacy row with no source is shown as itself.
    expect(byProvenance.unclassified).toBeCloseTo(3.1);
  });

  it("spreads a domain order across the twelve months it covers", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 100 });
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: DOMAINS });

    const nom = payload.domains.find((d) => d.domain === "northwind.example")!;
    expect(nom.perMonth).toBeCloseTo(9.14);
    expect(nom.firstPeriod).toBe("2026-01");
    expect(nom.lastPeriod).toBe("2026-12");

    const meadow = payload.domains.find((d) => d.domain === "meadow.example")!;
    expect(meadow.firstPeriod).toBe("2026-03");
    expect(meadow.lastPeriod).toBe("2027-02");

    expect(payload.domains[0]!.domain).toBe("northwind.example");
  });

  /** The collection editor on /financials addresses an array row by its index
   * (`/costs/0`) and guards the write with the row itself, so these two arrays
   * may not be sorted. `domains` above is sorted from the same input. */
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
    // Cheapest first in the file, so the sorted view below cannot agree with
    // file order by accident.
    const ORDERS: DomainOrder[] = [DOMAINS[1]!, DOMAINS[0]!];
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 100 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE,
      now: NOW,
      domainOrders: ORDERS,
      recurringCosts: RECURRING,
    });

    expect(payload.recurringCosts).toEqual(RECURRING);
    expect(payload.domainOrders).toEqual(ORDERS);
    expect(payload.domainOrders.map((o) => o.domain)).toEqual(["meadow.example", "northwind.example"]);
    expect(payload.domains.map((d) => d.domain)).toEqual(["northwind.example", "meadow.example"]);
    expect(payload.domainOrders[0]).not.toHaveProperty("perMonth");
  });

  it("treats an absent recurring-cost register as an empty list", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 100 });
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    expect(payload.recurringCosts).toEqual([]);
    expect(payload.domainOrders).toEqual([]);
  });

  /** A sum of no revenue rows and a sum of a $0.00 row are both 0, so whether
   * anything reported at all travels as a flag the row draws as a dash. */
  it("says which assets reported any revenue in the month, apart from the amount", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "revenue", asset: "northwind.example", period: "2026-08", family: "ads", minor: 0 });
    await ledger({ kind: "cost", asset: "northwind.example", period: "2026-08", family: "infra", minor: 914 });
    await asset(ctx, "acorn.example", "acorn.example");
    await ledger({ kind: "cost", asset: "acorn.example", period: "2026-08", family: "infra", minor: 92 });
    await ledger({ kind: "revenue", asset: "acorn.example", period: "2026-07", family: "ads", minor: 50 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: DOMAINS });
    const reported = Object.fromEntries(payload.properties.map((p) => [p.asset, p.revenueReported]));
    expect(reported).toEqual({ "meadow.example": true, "northwind.example": true, "acorn.example": false });
    expect(payload.properties.find((p) => p.asset === "northwind.example")!.figure.revenue!).toBe(0);
    expect(payload).not.toHaveProperty("gaps");
  });

  it("ignores a superseded estimate", async () => {
    await ledger({ id: 1, kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 45000, state: "reconciled",
      supersedes: 1, recordedAt: "2026-08-20T00:00:00.000Z" });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: NOW, domainOrders: [] });
    const august = payload.months.find((m) => m.period === "2026-08")!;
    expect(august.booked.revenue!).toBeCloseTo(450);
    expect(august.estimated.revenue).toBe(0);
    expect(august.total.revenue!).toBeCloseTo(450);
  });
});

/** Every row in this ledger lands by import or by hand, so the first days of
 * a month hold none. */
describe("buildFinancialsPayload — the period it describes", () => {
  /** A day inside a month the seeded ledger below has no row for. */
  const SEPTEMBER = new Date("2026-09-04T12:00:00.000Z");

  async function seedThreeMonths(): Promise<void> {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
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
    expect(
      payload.properties.find((p) => p.asset === "meadow.example")!.figure.revenue!,
    ).toBeCloseTo(440.94);
    expect(payload.costLines).not.toHaveLength(0);
  });

  it("stays on the current month the moment it holds one row", async () => {
    await seedThreeMonths();
    await ledger({ kind: "cost", asset: "northwind.example", period: "2026-09", family: "infra", minor: 914 });
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });

    expect(payload.period).toBe("2026-09");
    expect(payload.periodIsCurrent).toBe(true);
  });

  it("lists every period the ledger holds a current row for, ascending", async () => {
    await seedThreeMonths();
    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });

    expect(payload.periods).toEqual(["2026-06", "2026-07", "2026-08"]);
    // Same rows, same predicate as the trajectory table.
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
      payload.properties.find((p) => p.asset === "meadow.example")!.figure.revenue!,
    ).toBeCloseTo(200);
    expect(payload.months).toHaveLength(3);
  });

  /** A month the ledger has nothing for is a miss, never a quiet redirect to
   * a neighbour. */
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
    expect(payload.period).toBe("2026-09");
    expect(payload.periodIsCurrent).toBe(true);
  });

  // The store refuses a correction in another month
  // (`ledger_correction_matches_target`), so no month is ever emptied.
  it("never holds a correction in another month, so no month is left with only a superseded row", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ id: 7, kind: "revenue", asset: "meadow.example", period: "2026-07", family: "ads", minor: 100 });
    await expect(
      ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 100, state: "reconciled", supersedes: 7 }),
    ).rejects.toThrow(/same site, month, kind, family and currency/);

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    expect(payload.periods).toEqual(["2026-07", "2026-08"]);
  });

  // The route checks the shape before it touches the store.
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

/** The share bar answers which asset is carrying this month; only a series
 * answers which one is getting better. The line is the same arithmetic as the
 * figure beside it, and it never invents a month the ledger has no row for. */
describe("buildFinancialsPayload — each asset's own months", () => {
  const SEPTEMBER = new Date("2026-09-04T12:00:00.000Z");

  it("carries every month the asset has a row in, ascending, revenue minus direct cost", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "cost", asset: "meadow.example", period: "2026-06", family: "api", minor: 500 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meadow = payload.properties.find((p) => p.asset === "meadow.example")!;

    expect(meadow.months.map((month) => month.period)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(meadow.months.map((month) => month.figure?.net ?? null)).toEqual([95, 200, 440.94]);
    expect(meadow.months[0]!.figure).toEqual({ currency: 'USD', revenue: 100, cost: 5, net: 95 });
  });

  /** The figure the row prints and the point its line ends on are the same
   * grouping asked for the same month. */
  it("makes the selected month's point the row's own figure", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "meadow.example", period: "2026-08", family: "api", minor: 305 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE,
      now: SEPTEMBER,
      domainOrders: [],
      period: "2026-07",
    });
    const meadow = payload.properties.find((p) => p.asset === "meadow.example")!;

    expect(meadow.months.find((month) => month.period === "2026-07")!.figure).toEqual(
      meadow.figure,
    );
    expect(meadow.months.map((month) => month.period)).toEqual(["2026-07", "2026-08"]);
  });

  /** A month the asset booked nothing in is present so a sparkline spaces the
   * months correctly, and null so nothing reads a figure where there is none. */
  it("fills a skipped month with a null rather than a figure or nothing", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meadow = payload.properties.find((p) => p.asset === "meadow.example")!;

    expect(meadow.months).toEqual([
      { period: "2026-06", figure: { currency: 'USD', revenue: 100, cost: 0, net: 100 } },
      { period: "2026-07", figure: null },
      { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 0, net: 440.94 } },
    ]);
  });

  /** An asset whose first row is August has no June; and an asset whose axis
   * merely spans the selected month with a hole in it is not a row of a table
   * describing that month. */
  it("starts each asset's axis at its own first row, and lists no asset whose selected month is a hole", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "northwind.example", period: "2026-08", family: "infra", minor: 914 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    expect(payload.properties.find((p) => p.asset === "northwind.example")!.months).toEqual([
      { period: "2026-08", figure: { currency: 'USD', revenue: 0, cost: 9.14, net: -9.14 } },
    ]);

    // July is a hole for Meadow Board and northwind.example has no July at all.
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

  /** A manufactured run of zeroes would draw a cliff the ledger never recorded. */
  it("gives an asset no point for a month it has no row in", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-06", family: "ads", minor: 10000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "cost", asset: "northwind.example", period: "2026-08", family: "infra", minor: 914 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const nom = payload.properties.find((p) => p.asset === "northwind.example")!;

    expect(nom.months.map((month) => month.period)).toEqual(["2026-08"]);
    expect(payload.periods).toHaveLength(3);
  });

  it("yields a one-point series from a single-month ledger", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meadow = payload.properties.find((p) => p.asset === "meadow.example")!;

    expect(meadow.months).toEqual([
      { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 0, net: 440.94 } },
    ]);
  });

  it("excludes a superseded row from the series", async () => {
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-07", family: "ads", minor: 20000 });
    await ledger({ id: 1, kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 44094 });
    await ledger({ kind: "revenue", asset: "meadow.example", period: "2026-08", family: "ads", minor: 45000, state: "reconciled",
      supersedes: 1, recordedAt: "2026-08-20T00:00:00.000Z" });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const meadow = payload.properties.find((p) => p.asset === "meadow.example")!;

    expect(meadow.months.map((month) => month.figure?.net ?? null)).toEqual([200, 450]);
  });

  /** Asset #0 is a row of this grouping too, the overhead line, so nothing
   * here is special-cased on `is_os`. */
  it("gives the overhead asset its months as well", async () => {
    await ledger({ kind: "cost", asset: "root-os", period: "2026-07", family: "inference", minor: 20000 });
    await ledger({ kind: "cost", asset: "root-os", period: "2026-08", family: "inference", minor: 20500 });

    const payload = await buildFinancialsPayload(ctx.call, { osTimeZone: OS_TIME_ZONE, now: SEPTEMBER, domainOrders: [] });
    const os = payload.properties.find((p) => p.isOs)!;

    expect(os.months.map((month) => month.figure?.net ?? null)).toEqual([-200, -205]);
    expect(os.displayName).toBe("NoticeOS");
    expect(JSON.stringify(payload)).not.toContain("ReindexOS");
  });
});
