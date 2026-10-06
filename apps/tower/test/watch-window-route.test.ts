// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  CreateWatchWindowInput,
  CreateWatchWindowResult,
  WatchWindowRow,
} from "@noticeos/contract";
import { WATCH_SERIES } from "@noticeos/contract";
import {
  handleWatchWindowRequest,
  type WatchWindowWriter,
} from "../worker/watch-window-route";
import {
  WATCH_BASELINE_DAYS,
  WATCH_MIN_WINDOW_COVERAGE,
  watchBaselineFor,
  watchCalibration,
  watchCalibrationBasis,
  watchCheckDates,
  watchCheckOffsets,
  watchDraftBody,
  watchDraftIssues,
  watchScopeState,
  watchSeriesForSources,
  watchSeriesLabel,
  watchVerdictFigures,
  storedWatchScope,
  type WatchDraft,
  type WatchQueryHistory,
  type WatchSeriesHistory,
} from "@shared/watch-windows";

// Opening a pre-registered outcome check from the Tower (bead `ro-71r`).
//
// Two halves are asserted here. The BOUNDARY: what crosses to ingest and how
// each answer it can give is rendered for the browser — the registration rules
// themselves live in workers/ingest/test/watch-windows.test.ts against real D1,
// which stays their only home. And the DERIVATIONS the composer prefills from,
// which are the honesty-critical half: a form that quietly widened a baseline or
// backdated a registration would be pre-registration in name only.
//
// The binding is stubbed rather than bound: this project's Vitest runs in
// node/jsdom with no workerd, so a real WorkerEntrypoint cannot be instantiated
// here. The stub is typed by the shared contract, so a change to the RPC's shape
// breaks these tests at compile time.

const REQUEST_URL = new URL(
  "https://tower.local/api/assets/meals.example/watch-windows",
);

function row(overrides: Partial<WatchWindowRow> = {}): WatchWindowRow {
  return {
    id: "8f0d2d2a-0000-4000-8000-000000000000",
    asset: "meals.example",
    ref_kind: "annotation",
    ref: "41",
    metric_integration: "gsc",
    metric: "clicks",
    scope_json: null,
    registered_at: "2026-08-04T12:00:00.000Z",
    baseline_start: "2026-06-14",
    baseline_end: "2026-07-11",
    check_offsets_json: "[7,14,28]",
    thresholds_json: '{"ship":{"direction":"up","min_delta_pct":10}}',
    readings_json: "[]",
    status: "open",
    outcome: null,
    last_checked_at: null,
    closed_at: null,
    note: "July title batch",
    outcome_note: null,
    created_at: "2026-08-04T12:00:00.000Z",
    readback_bead: null,
    readback_posted_at: null,
    ...overrides,
  };
}

/** The INGEST Service Binding, stubbed at its one RPC. */
function stubIngest(reply: CreateWatchWindowResult | Error): {
  ingest: WatchWindowWriter;
  calls: CreateWatchWindowInput[];
} {
  const calls: CreateWatchWindowInput[] = [];
  return {
    calls,
    ingest: {
      async createWatchWindow(input) {
        calls.push(input);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

const registered: CreateWatchWindowResult = { ok: true, created: true, watchWindow: row() };

/** A same-origin browser write, as the Tower's own fetch produces it. */
function post(body: unknown, init: RequestInit = {}): Request {
  return new Request(REQUEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function handle(
  request: Request,
  ingest: WatchWindowWriter,
  asset = "meals.example",
) {
  return handleWatchWindowRequest(request, REQUEST_URL, ingest, asset);
}

/** The composer's default draft for a change on 2026-07-12 — the README's own
 * documented example, arrived at by prefill rather than by hand. */
function draft(overrides: Partial<WatchDraft> = {}): WatchDraft {
  const baseline = watchBaselineFor("2026-07-12");
  return {
    refKind: "annotation",
    ref: "41",
    series: WATCH_SERIES[0]!,
    baselineStart: baseline.start,
    baselineEnd: baseline.end,
    verdictDays: 28,
    minDeltaPct: 10,
    note: "July title batch",
    scope: null,
    ...overrides,
  };
}

describe("POST /api/assets/:id/watch-windows", () => {
  it("hands the registration to the worker that owns the table", async () => {
    const { ingest, calls } = stubIngest(registered);
    const response = await handle(
      post({
        ref_kind: "annotation",
        ref: "41",
        metric_integration: "gsc",
        metric: "clicks",
        baseline_start: "2026-06-14",
        baseline_end: "2026-07-11",
        check_offsets: [7, 14, 28],
        thresholds: {
          ship: { direction: "up", min_delta_pct: 10 },
          kill: { direction: "down", min_delta_pct: 10 },
        },
        note: "July title batch",
      }),
      ingest,
    );

    // The asset comes from the path, never from the body: a page registers a
    // watch on the asset it is showing and on nothing else.
    expect(calls[0]?.asset).toBe("meals.example");
    expect(calls[0]).toMatchObject({
      ref_kind: "annotation",
      ref: "41",
      metric_integration: "gsc",
      metric: "clicks",
      baseline_start: "2026-06-14",
      baseline_end: "2026-07-11",
      check_offsets: [7, 14, 28],
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      asset: "meals.example",
      id: "8f0d2d2a-0000-4000-8000-000000000000",
    });
  });

  it("never defaults a registration field the operator did not see", async () => {
    const { ingest, calls } = stubIngest(registered);
    await handle(post({ ref_kind: "manual", ref: "batch" }), ingest);
    // No Tower-side clock and no Tower-side baseline: a comparison the operator
    // never chose is not a pre-registration.
    expect(calls[0]?.registered_at).toBeUndefined();
    expect(calls[0]?.baseline_start).toBeUndefined();
    expect(calls[0]?.scope).toBeUndefined();
  });

  it("carries the query a check was opened from, so it is watched inside that query", async () => {
    // Dropped, the check was registered site-wide — another comparison than
    // the composer drew — and every average was refused (bead ro-ujb9.96.6.28).
    const { ingest, calls } = stubIngest(registered);
    await handle(post({ ref_kind: "manual", ref: "batch", scope: { query: "example query" } }), ingest);
    expect(calls[0]?.scope).toEqual({ query: "example query" });
  });

    it("sends a note the operator left blank as absent, not as an empty string", async () => {
    const { ingest, calls } = stubIngest(registered);
    await handle(post({ ref_kind: "manual", ref: "batch", note: "   " }), ingest);
    expect(calls[0]?.note).toBeNull();
  });

  it("carries ingest's own sentence back, so a refusal is readable", async () => {
    const { ingest } = stubIngest({
      ok: false,
      error: "validation",
      issues: [
        {
          path: "baseline_end",
          code: "custom",
          message: "baseline_end must be on or before 2026-08-04",
        },
      ],
    });
    const response = await handle(post({ ref_kind: "manual", ref: "x" }), ingest);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid_watch_window",
      field: "baseline_end",
      detail: "baseline_end must be on or before 2026-08-04",
    });
  });

  it("answers an unknown asset with 404, never a foreign-key 500", async () => {
    const { ingest } = stubIngest({
      ok: false,
      error: "unknown_asset",
      asset: "does.not.exist",
    });
    const response = await handle(
      post({ ref_kind: "manual", ref: "x" }),
      ingest,
      "does.not.exist",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "asset_not_found",
      id: "does.not.exist",
    });
  });

  it("keeps a failed write opaque instead of leaking ingest's internals", async () => {
    const { ingest } = stubIngest(
      new Error("D1_ERROR: no such table: watch_windows"),
    );
    const response = await handle(post({ ref_kind: "manual", ref: "x" }), ingest);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "watch_window_write_failed" });
  });

  it("rejects a cross-origin write without ever calling ingest", async () => {
    const { ingest, calls } = stubIngest(registered);
    const foreign = new Request(REQUEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: "{}",
    });
    expect((await handle(foreign, ingest)).status).toBe(403);
    expect((await handle(post({}, { headers: {} }), ingest)).status).toBe(415);
    expect(calls).toEqual([]);
  });
});

describe("the composer's prefill (bead ro-71r)", () => {
  it("proposes the four whole weeks BEFORE the change, excluding its own day", () => {
    // The change ships at some hour, so its day is part before and part after.
    // Including it would put a slice of the thing being measured inside the
    // window it is measured against.
    expect(watchBaselineFor("2026-07-12")).toEqual({
      start: "2026-06-14",
      end: "2026-07-11",
    });
    expect(WATCH_BASELINE_DAYS).toBe(28);
  });

  it("builds the body the ingest README documents, from one click", () => {
    expect(watchDraftBody(draft())).toEqual({
      ref_kind: "annotation",
      ref: "41",
      metric_integration: "gsc",
      metric: "clicks",
      baseline_start: "2026-06-14",
      baseline_end: "2026-07-11",
      check_offsets: [7, 14, 28],
      thresholds: {
        ship: { direction: "up", min_delta_pct: 10 },
        kill: { direction: "down", min_delta_pct: 10 },
      },
      note: "July title batch",
    });
  });

  it("never backdates, though the route would allow it", () => {
    // Backdated to a change two months old, a 28-day window's final check has
    // already passed and closes on the next nightly run — a verdict read out of
    // numbers the operator had already seen, which is the exact self-deception
    // pre-registration exists to prevent.
    expect(watchDraftBody(draft())).not.toHaveProperty("registered_at");
    // An asset-level composer does not invent a narrower selector.
    expect(watchDraftBody(draft())).not.toHaveProperty("scope");
  });

  it("carries an exact query selector only when the surface supplied one", () => {
    expect(
      watchDraftBody(draft({ scope: { query: "chipotle calories" } })),
    ).toMatchObject({ scope: { query: "chipotle calories" } });
  });

  it("flips the predicate for a metric where better means smaller", () => {
    const position = WATCH_SERIES.find((s) => s.metric === "position")!;
    expect(watchDraftBody(draft({ series: position })).thresholds).toEqual({
      ship: { direction: "down", min_delta_pct: 10 },
      kill: { direction: "up", min_delta_pct: 10 },
    });
  });

  it("reads a window again before its verdict, never instead of it", () => {
    expect(watchCheckOffsets(28)).toEqual([7, 14, 28]);
    expect(watchCheckOffsets(56)).toEqual([14, 28, 56]);
    // The final offset is always last, because the evaluator closes on it.
    expect(watchCheckOffsets(90).at(-1)).toBe(90);
  });

  it("names a series the same way the pending list will", () => {
    // The chooser and the strip that later reports the verdict cannot call the
    // same number two things.
    expect(watchSeriesLabel("gsc", "position")).toBe("Google average position");
    expect(watchSeriesLabel("ga4", "active_users")).toBe("Analytics active users");
    // A row this build does not know about still renders as words.
    expect(watchSeriesLabel("gsc", "future_metric")).toBe("Google future metric");
  });
});

describe("the composer refuses what the route would refuse (bead ro-71r)", () => {
  const TODAY = "2026-08-04";

  it("accepts the prefilled draft as it stands", () => {
    expect(watchDraftIssues(draft(), TODAY)).toEqual([]);
  });

  it("refuses a baseline running past today — it is the window BEFORE the change", () => {
    const issues = watchDraftIssues(
      draft({ baselineStart: "2026-08-01", baselineEnd: "2026-08-31" }),
      TODAY,
    );
    expect(issues[0]?.field).toBe("baseline");
    expect(issues[0]?.message).toContain("2026-08-04");
  });

  it("refuses a verdict that arrives before the baseline is long", () => {
    // The final post window is baseline-length and ends on the check date, so a
    // too-early verdict reaches back over the change.
    const baseline = watchBaselineFor("2026-07-12");
    const issues = watchDraftIssues(
      draft({
        baselineStart: "2026-04-01",
        baselineEnd: baseline.end,
        verdictDays: 28,
      }),
      TODAY,
    );
    expect(issues.some((issue) => issue.field === "verdict")).toBe(true);
  });

  it("refuses a backwards baseline and an unnamed subject", () => {
    expect(
      watchDraftIssues(
        draft({ baselineStart: "2026-07-11", baselineEnd: "2026-06-14" }),
        TODAY,
      )[0]?.field,
    ).toBe("baseline");
    expect(
      watchDraftIssues(draft({ refKind: "manual", ref: "  " }), TODAY)[0]?.field,
    ).toBe("ref");
  });

  it("refuses a predicate with no size, because that is not a predicate", () => {
    expect(
      watchDraftIssues(draft({ minDeltaPct: 0 }), TODAY)[0]?.field,
    ).toBe("threshold");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bead ro-5e8.2 — the threshold is this asset's number, not the README's.
//
// The claim under test is traceability: every figure the composer prints has to
// come out of the asset's own series through the EVALUATOR's arithmetic, and
// the one case that must not produce a confident-looking number is an asset
// with nothing to calibrate from.
// ─────────────────────────────────────────────────────────────────────────────
describe("threshold calibration (bead ro-5e8.2)", () => {
  const history = (
    values: (number | null)[],
    firstDay = "2026-01-01",
  ): WatchSeriesHistory => {
    const lastDay = new Date(
      Date.parse(`${firstDay}T00:00:00.000Z`) +
        (values.length - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    return {
      integration: "gsc",
      metric: "clicks",
      firstDay,
      values,
      recordedChanges: { firstDay, lastDay, days: [], complete: true },
    };
  };

  /** A series that alternates between two levels every `days` days. */
  const alternating = (days: number, low: number, high: number, cycles: number) =>
    Array.from({ length: days * cycles }, (_, i) =>
      Math.floor(i / days) % 2 === 0 ? low : high,
    );

  /** Deterministic wobble, so a test about noise is not a test about luck. */
  const wobbly = (length: number) => {
    let seed = 7;
    return Array.from({ length }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return 50 + (seed % 100);
    });
  };

  it("calibrates an asset that never moves to the smallest predicate there is", () => {
    // A flat series has no noise to clear, so the floor is 0 — and the prefill
    // is 1, not 0, because `watchDraftIssues` refuses a predicate with no size
    // and a form cannot prefill a value it would then reject.
    const result = watchCalibration(history(Array.from({ length: 60 }, () => 100)), 14);
    expect(result!.floorPct).toBe(0);
    expect(result!.suggestedPct).toBe(1);
  });

  it("measures the move this asset makes when nothing was registered", () => {
    // 100 for a week, 110 the next, over and over. Every comparison the
    // evaluator would make on this series is a swing of that size or less, and
    // the prefill has to sit ABOVE the whole distribution of them.
    const result = watchCalibration(history(alternating(7, 100, 110, 12)), 7);
    expect(result).not.toBeNull();
    expect(result!.windowDays).toBe(7);
    expect(result!.floorPct).toBeGreaterThan(5);
    expect(result!.comparisons).toBeGreaterThan(20);
    // A threshold EQUAL to the floor fires on the historical pair that produced
    // it, so the prefill is strictly above it and whole.
    expect(result!.suggestedPct).toBeGreaterThan(result!.floorPct);
    expect(Number.isInteger(result!.suggestedPct)).toBe(true);
  });

  it("calibrates at the window length actually chosen, not a fixed one", () => {
    // A wider window is quieter, and that is the whole reason the floor cannot
    // be measured once at 28 days and reused: the same series, compared over a
    // longer stretch, moves less. A composer that widened the baseline while
    // holding a 28-day floor would demand a move no real result could reach.
    const noisy = history(wobbly(300));
    const short = watchCalibration(noisy, 7);
    const long = watchCalibration(noisy, 28);
    expect(long!.windowDays).toBe(28);
    expect(long!.floorPct).toBeLessThan(short!.floorPct);
  });

  it("excludes every comparison that crosses a recorded level-changing deploy", () => {
    const firstDay = "2026-01-01";
    const values = [
      ...Array.from({ length: 42 }, () => 100),
      ...Array.from({ length: 42 }, () => 200),
    ];
    const contaminated = watchCalibration(
      { integration: "gsc", metric: "clicks", firstDay, values },
      7,
    )!;
    const filtered = watchCalibration(
      {
        ...history(values, firstDay),
        recordedChanges: {
          firstDay,
          lastDay: "2026-03-25",
          days: ["2026-02-12"],
          complete: true,
        },
      },
      7,
    )!;

    expect(contaminated.floorPct).toBeGreaterThan(0);
    expect(filtered).toMatchObject({
      floorPct: 0,
      suggestedPct: 1,
      recordedChangeDays: 1,
      excludedComparisons: 14,
      changeCalendarComplete: true,
    });
    expect(filtered.comparisons).toBe(57);
  });

  it("labels a measurable floor historical when its change calendar is incomplete", () => {
    const series = WATCH_SERIES.find((s) => s.metric === "clicks")!;
    const incomplete = watchCalibration(
      {
        integration: "gsc",
        metric: "clicks",
        firstDay: "2026-01-01",
        values: Array.from({ length: 84 }, () => 100),
      },
      7,
    )!;
    expect(incomplete.changeCalendarComplete).toBe(false);
    // Still this asset's measurable floor — and the composer's "Changes not
    // excluded" chip reads `changeCalendarComplete`, never a sentence.
    expect(series.metric).toBe("clicks");
    expect(watchCalibrationBasis(incomplete)).toEqual({ kind: "asset", calibration: incomplete });
    expect(incomplete.excludedComparisons).toBe(0);
  });

  it("skips a stretch the evaluator would have closed unmeasurable", () => {
    // The evaluator refuses a window under 80% coverage, so a floor measured
    // over one would describe a comparison nobody ever gets. Ten days of data,
    // then a hole big enough to void every window that touches it.
    const holed = [
      ...Array.from({ length: 14 }, () => 100),
      ...Array.from({ length: 14 }, () => null),
      ...Array.from({ length: 14 }, () => 100),
    ];
    expect(watchCalibration(history(holed), 14)).toBeNull();
  });

  it("says nothing rather than calibrating from an asset that just started", () => {
    // A number derived from four days would look exactly as authoritative as
    // one derived from six months, which is the failure this bead is about.
    expect(watchCalibration(history([1, 2, 3, 4]), 28)).toBeNull();
    expect(watchCalibration(null, 28)).toBeNull();
  });

  it("refuses to divide by a baseline of zero, exactly as the evaluator does", () => {
    expect(
      watchCalibration(history(Array.from({ length: 60 }, () => 0)), 14),
    ).toBeNull();
  });

  it("carries where the number came from as evidence, not a sentence", () => {
    const result = watchCalibration(history(alternating(7, 100, 110, 12)), 7)!;
    const basis = watchCalibrationBasis(result);
    expect(basis.kind).toBe("asset");
    // The span, the asset's typical move, the floor, and how many comparisons
    // stand behind it — a number nobody can trace is a number the operator
    // overrides on feel. The composer draws each of these (route suite).
    expect(result.firstDay).toBe("2026-01-01");
    expect(result.floorPct).toBeGreaterThanOrEqual(result.typicalPct);
    expect(result.comparisons).toBeGreaterThan(0);
    expect(result.suggestedPct).toBe(Math.floor(result.floorPct) + 1);
  });

  it("admits when it is showing the README's example instead", () => {
    // Never a basis that claims to be this asset's number.
    expect(watchCalibrationBasis(null)).toEqual({ kind: "none", gap: "short-history" });
  });

  it("never lends site-wide calibration to a query-scoped threshold", () => {
    const siteCalibration = watchCalibration(history(alternating(7, 100, 110, 12)), 7)!;
    // No query history proves the grain, so the site floor is not admissible.
    expect(
      watchCalibrationBasis(siteCalibration, { query: "chipotle calories" }),
    ).toEqual({ kind: "none", gap: "no-query-archive" });
  });

  it("tells a sparse query archive apart from no archive at all", () => {
    const sparse: WatchQueryHistory = {
      integration: "gsc",
      metric: "clicks",
      query: "chipotle calories",
      firstDay: "2026-01-01",
      values: [3, null, 4],
      archiveFirstDay: "2026-01-01",
      archiveLastDay: "2026-01-03",
      archiveDays: 3,
      observedDays: 2,
      recordedChanges: { firstDay: "2026-01-01", lastDay: "2026-01-03", days: [], complete: true },
    };
    expect(
      watchCalibrationBasis(watchCalibration(sparse, 7), { query: "chipotle calories" }, sparse),
    ).toEqual({ kind: "none", gap: "query-sparse" });
  });

  it("dates every check a registration made today would be read on", () => {
    expect(watchCheckDates("2026-09-22", 28)).toEqual(["2026-09-29", "2026-10-06", "2026-10-20"]);
    expect(watchCheckDates("2026-09-22", 28).at(-1)).toBe("2026-10-20");
  });

  it("names the query archive and its own floor when query history is sufficient", () => {
    const series = WATCH_SERIES.find((s) => s.metric === "clicks")!;
    const site = watchCalibration(history(alternating(7, 100, 160, 12)), 7)!;
    const queryHistory: WatchQueryHistory = {
      integration: "gsc",
      metric: "clicks",
      query: "chipotle calories",
      firstDay: "2026-01-01",
      values: Array.from({ length: 84 }, () => 20),
      archiveFirstDay: "2026-01-01",
      archiveLastDay: "2026-03-25",
      archiveDays: 84,
      observedDays: 84,
      recordedChanges: {
        firstDay: "2026-01-01",
        lastDay: "2026-03-25",
        days: [],
        complete: true,
      },
    };
    const query = watchCalibration(queryHistory, 7)!;
    expect(site.suggestedPct).toBeGreaterThan(query.suggestedPct);

    const basis = watchCalibrationBasis(query, { query: "chipotle calories" }, queryHistory);
    expect(series.metric).toBe("clicks");
    // The query's own floor, with the archive that proves its grain — never
    // the site's.
    expect(basis).toEqual({ kind: "query", calibration: query, history: queryHistory });
    expect(query.typicalPct).toBe(0);
    expect(query.floorPct).toBe(0);
    expect(query.suggestedPct).toBe(1);
    expect(query.suggestedPct).not.toBe(site.suggestedPct);
  });

  it("opens a seeded composer on the number the surface was about", () => {
    // Bead ro-5e8.5. A finding names its provider and not a metric, so the
    // metric is that provider's headline outcome — the number the work the
    // finding asks for is meant to move.
    expect(watchSeriesForSources(["gsc/page-query"])).toMatchObject({
      integration: "gsc",
      metric: "clicks",
    });
    expect(watchSeriesForSources(["ga4/page-events"])).toMatchObject({
      integration: "ga4",
      metric: "sessions",
    });
    // The FIRST source the evaluator can actually read wins, so a finding built
    // on a provider it cannot measure still opens on one it can.
    expect(
      watchSeriesForSources(["clarity/url-3d", "ga4/page-events"]),
    ).toMatchObject({ integration: "ga4" });
    // And a finding with nothing measurable prefills nothing: the composer's
    // own default (the asset's first live lane) is a better answer than a
    // confident wrong one.
    expect(watchSeriesForSources(["dataforseo/ranked-keywords"])).toBeNull();
  });

  it("states when a query is measured directly and when a provider widens it", () => {
    const clicks = WATCH_SERIES.find((s) => s.metric === "clicks")!;
    const seed = {
      subject: "“chipotle calories” — ranking opportunity",
      series: clicks,
      query: "chipotle calories",
      beadId: null,
    };
    expect(watchScopeState(seed, clicks)).toEqual({ kind: "query", query: "chipotle calories" });

    const analytics = WATCH_SERIES.find((s) => s.integration === "ga4")!;
    expect(watchScopeState(seed, analytics)).toEqual({ kind: "widened", query: "chipotle calories" });
    // Nothing was narrowed, so nothing is flagged: a form that warned about a
    // limit it was not hitting would train the operator to skip this line.
    expect(
      watchScopeState({
        subject: "a finding",
        series: clicks,
        query: null,
        beadId: null,
      }, clicks),
    ).toBeNull();
    expect(watchScopeState(null, clicks)).toBeNull();
  });

  it("holds the same coverage rule the evaluator judges by", () => {
    // Stated as a contract constant so the two cannot drift; the ingest suite
    // pins its own MIN_WINDOW_COVERAGE against this same value.
    expect(WATCH_MIN_WINDOW_COVERAGE).toBe(0.8);
  });
});

// Bead `ro-ujb9.96.6.30`: a closed window's note is drawn as the evaluator's
// figures. Notes stored before the ingest stopped writing the series, scope and
// offset still start with them; only that exact prefix, for the row's own
// series, is dropped.
describe("a closed watch's stored verdict", () => {
  it("drops the store's series, scope and offset from an older note", () => {
    expect(watchVerdictFigures("gsc/clicks at +28d: 40/day vs baseline 38/day (+5%)", "gsc", "clicks"))
      .toBe("40/day vs baseline 38/day (+5%)");
    expect(
      watchVerdictFigures(
        "gsc/position for query “best: protein” at +7d: 8.5/day vs baseline 7.8/day (+9%)",
        "gsc",
        "position",
      ),
    ).toBe("8.5/day vs baseline 7.8/day (+9%)");
    expect(
      watchVerdictFigures(
        "gsc/clicks for page https://example.com/meal-plans/ at +28d: no observations in the post window",
        "gsc",
        "clicks",
      ),
    ).toBe("no observations in the post window");
    expect(
      watchVerdictFigures("gsc/clicks: stored scope unsupported · no site-wide fallback", "gsc", "clicks"),
    ).toBe("stored scope unsupported · no site-wide fallback");
    expect(
      watchVerdictFigures(
        'gsc/clicks at +28d: baseline on "https://example.com/", post window on "sc-domain:example.com"',
        "gsc",
        "clicks",
      ),
    ).toBe('baseline on "https://example.com/", post window on "sc-domain:example.com"');
  });

  it("returns a note the evaluator wrote today, or another series' words, as stored", () => {
    expect(watchVerdictFigures("13/day vs baseline 10/day (+30%)", "gsc", "clicks"))
      .toBe("13/day vs baseline 10/day (+30%)");
    expect(watchVerdictFigures("ga4/sessions at +28d: 1/day", "gsc", "clicks"))
      .toBe("ga4/sessions at +28d: 1/day");
    expect(watchVerdictFigures("Change was inside normal variation.", "ga4", "active_users"))
      .toBe("Change was inside normal variation.");
    expect(watchVerdictFigures(null, "gsc", "clicks")).toBeNull();
  });

  it("reads a stored scope as one query or one page, and anything else as none", () => {
    expect(storedWatchScope('{"query":" high protein meal plan "}')).toEqual({ query: "high protein meal plan" });
    expect(storedWatchScope('{"page":"/meal-plans"}')).toEqual({ page: "/meal-plans" });
    expect(storedWatchScope(null)).toBeNull();
    expect(storedWatchScope('{"country":"usa"}')).toBeNull();
    expect(storedWatchScope('{"query":"a","page":"/b"}')).toBeNull();
    expect(storedWatchScope('{"query":"  "}')).toBeNull();
    expect(storedWatchScope("not json")).toBeNull();
  });
});
