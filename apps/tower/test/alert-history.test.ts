// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_HISTORY_MAX_LIMIT,
  ALERT_HISTORY_PAGE,
  alertHistoryQueryString,
  alertOpenMs,
  parseAlertHistoryQuery,
} from "../shared/alert-history";
import {
  buildAlertHistoryPayload,
  handleAlertHistoryRequest,
} from "../worker/alert-history";
import { openFlagsSql, settledFlagsSql, snoozedFlagsSql } from "../worker/flag-scope";
import { readAlerts, storeAlert, storeReading } from "./alert-rows";
import { storeChanges } from "./change-rows";
import { type TestStore, createTestStore } from "./postgres-store";
import { addSites } from "./sites";

// GET /api/alerts/history — the portfolio's settled alerts (bead `ro-ju7f`).
//
// Asserted against the REAL schema on a Postgres copy (bead ro-ujb9.76.5.2),
// so the filters, the ordering, the paging window and the count all run the
// SQL the Tower runs. The one thing these tests are really guarding is that a paged archive
// stays HONEST: every row appears on exactly one page, the total describes the
// filtered set rather than the page, and the rows say the same thing the asset
// page's own history says about the same store.

const NOW = new Date("2026-09-04T12:00:00.000Z");
const DAY = 86_400_000;

function at(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString();
}

interface FlagSpec {
  asset: string;
  firedAt: string;
  severity?: "error" | "warn" | "info";
  kind?: "anomaly" | "opportunity" | "milestone";
  message?: string;
  ruleId?: string;
  disposition?: "ack" | "snooze" | "tune" | "incident" | "hypothesis" | null;
  dispositionAt?: string | null;
  dispositionNote?: string | null;
  /** For `disposition: "snooze"` — when the condition returns (`ro-c7qq`). */
  snoozeUntil?: string | null;
  resolvedAt?: string | null;
}

/** A site in both of the test's stores (test/sites.ts): the page names sites
 * from the site list on Postgres. */
async function insertAsset(
  raw: TestStore,
  id: string,
  domain: string | null,
  displayName: string,
  isOs = 0,
): Promise<void> {
  await addSites(raw, [{ id, domain, displayName, status: "live", senseOnly: 0, isOs, createdAt: "2026-07-01T00:00:00.000Z" }]);
}

/** One alert, on Postgres in the test's copy of its sites: its number. */
async function insertFlag(db: TestStore, spec: FlagSpec): Promise<number> {
  return storeAlert(db.call, {
    asset: spec.asset,
    firedAt: spec.firedAt,
    severity: spec.severity ?? "warn",
    kind: spec.kind ?? "anomaly",
    metric: null,
    message: spec.message ?? "something moved",
    ruleId: spec.ruleId ?? "volume-anomaly",
    ruleInputs: null,
    disposition: spec.disposition ?? null,
    dispositionAt: spec.dispositionAt ?? null,
    dispositionNote: spec.dispositionNote ?? null,
    snoozeUntil: spec.snoozeUntil ?? null,
    resolvedAt: spec.resolvedAt ?? null,
  });
}

let test: TestStore;

beforeEach(async () => {
  test = await createTestStore();
  await insertAsset(test, "meals.example", "meals.example", "Meal Planner");
  await insertAsset(test, "nosh.example", "nosh.example", "Nosh");
  // The OS row with the owner's pre-rename stored name (bead ro-ujb9.77.10).
  await insertAsset(test, "root-os", null, "ReindexOS", 1);
});

const query = (over: Partial<Parameters<typeof buildAlertHistoryPayload>[1]> = {}) => ({
  asset: null,
  severity: null,
  offset: 0,
  limit: ALERT_HISTORY_PAGE,
  malformed: null,
  ...over,
});

describe("the settled-alert read", () => {
  it("carries only alerts that were resolved or acknowledged", async () => {
    await insertFlag(test, { asset: "meals.example", firedAt: at(9), resolvedAt: at(7) });
    await insertFlag(test, {
      asset: "meals.example",
      firedAt: at(8),
      disposition: "ack",
      dispositionAt: at(6),
    });
    // Still open, and still open with a snooze that has nothing to do with
    // this read: neither belongs in history.
    await insertFlag(test, { asset: "meals.example", firedAt: at(2) });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });

    expect(payload.total).toBe(2);
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows.every((row) => row.flag.resolvedAt || row.flag.disposition)).toBe(true);
  });

  it("orders by when each row CLOSED, not when it fired", async () => {
    // The row that fired FIRST closed LAST. Ordering by fired_at would invert
    // this list, and "what settled most recently" is the question the page asks.
    const old = await insertFlag(test, {
      asset: "meals.example",
      firedAt: at(40),
      resolvedAt: at(1),
      message: "fired long ago, closed yesterday",
    });
    const recent = await insertFlag(test, {
      asset: "nosh.example",
      firedAt: at(3),
      resolvedAt: at(2),
      message: "fired recently, closed the day before",
    });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });

    expect(payload.rows.map((row) => row.flag.id)).toEqual([old, recent]);
  });

  it("falls back to the disposition time, then the firing, when nothing resolved it", async () => {
    const acked = await insertFlag(test, {
      asset: "nosh.example",
      firedAt: at(30),
      disposition: "ack",
      dispositionAt: at(1),
    });
    // Dispositioned before `disposition_at` existed: it has no closing time at
    // all and orders by its firing rather than dropping out of the list.
    //
    // Deliberately NOT `tune` (bead `ro-van6`): a tuned alert is still OPEN —
    // tuning the detector is not resolving the firing — so it belongs to the
    // open queue rather than to this settled read, and using it here would
    // assert the opposite of `worker/flag-scope.ts`.
    const undated = await insertFlag(test, {
      asset: "nosh.example",
      firedAt: at(5),
      disposition: "incident",
      dispositionAt: null,
    });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });

    expect(payload.rows.map((row) => row.flag.id)).toEqual([acked, undated]);
  });

  it("names the asset each row belongs to, with its domain", async () => {
    await insertFlag(test, { asset: "nosh.example", firedAt: at(4), resolvedAt: at(3) });
    // Asset #0 has no domain — the row still names it rather than blanking.
    await insertFlag(test, { asset: "root-os", firedAt: at(6), resolvedAt: at(5) });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });

    expect(payload.rows.map((row) => row.asset)).toEqual([
      { id: "nosh.example", domain: "nosh.example", displayName: "Nosh" },
      // The OS by the product's name, never its stored one.
      { id: "root-os", domain: null, displayName: "NoticeOS" },
    ]);
    expect(JSON.stringify(payload)).not.toContain("ReindexOS");
  });

  it("filters by asset and by severity, and the total follows the filter", async () => {
    await insertFlag(test, { asset: "meals.example", firedAt: at(9), resolvedAt: at(8), severity: "error" });
    await insertFlag(test, { asset: "meals.example", firedAt: at(7), resolvedAt: at(6), severity: "warn" });
    await insertFlag(test, { asset: "nosh.example", firedAt: at(5), resolvedAt: at(4), severity: "error" });

    const byAsset = await buildAlertHistoryPayload(
      test.call,
      query({ asset: "meals.example" }),
      { now: NOW },
    );
    expect(byAsset.total).toBe(2);
    expect(byAsset.rows.every((row) => row.asset.id === "meals.example")).toBe(true);

    const bySeverity = await buildAlertHistoryPayload(
      test.call,
      query({ severity: "error" }),
      { now: NOW },
    );
    expect(bySeverity.total).toBe(2);
    expect(bySeverity.rows.every((row) => row.flag.severity === "error")).toBe(true);

    const both = await buildAlertHistoryPayload(
      test.call,
      query({ asset: "meals.example", severity: "error" }),
      { now: NOW },
    );
    expect(both.total).toBe(1);
    expect(both.rows).toHaveLength(1);
  });

  it("carries INFO rows, which the open attention list never can", async () => {
    await insertFlag(test, {
      asset: "nosh.example",
      firedAt: at(20),
      severity: "info",
      kind: "milestone",
      message: "First 1,000 daily visitors",
      resolvedAt: at(19),
    });

    const payload = await buildAlertHistoryPayload(
      test.call,
      query({ severity: "info" }),
      { now: NOW },
    );

    expect(payload.total).toBe(1);
    expect(payload.rows[0]!.flag.kind).toBe("milestone");
  });

  describe("paging", () => {
    beforeEach(async () => {
      // Seven settled rows, each closed one day apart, so the expected page
      // contents are unambiguous.
      for (let i = 0; i < 7; i += 1) {
        await insertFlag(test, {
          asset: "meals.example",
          firedAt: at(20 + i),
          resolvedAt: at(1 + i),
          message: `row ${i}`,
        });
      }
    });

    it("returns one window at a time and states the whole", async () => {
      const first = await buildAlertHistoryPayload(
        test.call,
        query({ limit: 3 }),
        { now: NOW },
      );

      expect(first.rows).toHaveLength(3);
      expect(first.total).toBe(7);
      expect(first.offset).toBe(0);
      expect(first.limit).toBe(3);
      expect(first.hasMore).toBe(true);
      expect(first.rows.map((row) => row.flag.message)).toEqual([
        "row 0",
        "row 1",
        "row 2",
      ]);
    });

    it("never repeats or skips a row across the pages", async () => {
      const seen: number[] = [];
      for (let offset = 0; offset < 9; offset += 3) {
        const page = await buildAlertHistoryPayload(
          test.call,
          query({ limit: 3, offset }),
          { now: NOW },
        );
        seen.push(...page.rows.map((row) => row.flag.id));
      }
      expect(new Set(seen).size).toBe(7);
      expect(seen).toHaveLength(7);
    });

    it("says there is no more when the last page is short", async () => {
      const last = await buildAlertHistoryPayload(
        test.call,
        query({ limit: 3, offset: 6 }),
        { now: NOW },
      );

      expect(last.rows).toHaveLength(1);
      expect(last.hasMore).toBe(false);
    });

    it("answers an offset past the end with an empty page, not an error", async () => {
      const past = await buildAlertHistoryPayload(
        test.call,
        query({ offset: 500 }),
        { now: NOW },
      );

      expect(past.rows).toEqual([]);
      expect(past.total).toBe(7);
      expect(past.hasMore).toBe(false);
    });
  });

  it("attaches the timeline changes that sit in the 48h before a row fired", async () => {
    const fired = at(5);
    // Another asset's deploy in the same window must not travel with this row.
    await storeChanges(test.call, [
      { asset: "meals.example", at: at(5.5), kind: "deploy", ref: "abc1234", note: "shipped the new search page" },
      { asset: "nosh.example", at: at(5.5), kind: "deploy", ref: "def5678", note: "someone else shipped" },
    ]);
    await insertFlag(test, { asset: "meals.example", firedAt: fired, resolvedAt: at(4) });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });

    expect(payload.rows[0]!.flag.correlatedChanges).toHaveLength(1);
    expect(payload.rows[0]!.flag.correlatedChanges[0]!.ref).toBe("abc1234");
  });

  it("states every row as historical and standing for itself", async () => {
    await insertFlag(test, { asset: "meals.example", firedAt: at(9), resolvedAt: at(8) });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });

    // History is the audit trail: one row per FIRING, aged from its own
    // firing, never grouped the way an open condition is.
    expect(payload.rows[0]!.flag.occurrences).toBe(1);
    expect(payload.rows[0]!.flag.firstFiredAt).toBe(payload.rows[0]!.flag.firedAt);
    expect(payload.rows[0]!.flag.liveness).toEqual({ state: "historical" });
  });

  it("is empty rather than absent when the store holds nothing settled", async () => {
    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });

    expect(payload).toMatchObject({ rows: [], total: 0, hasMore: false });
    expect(payload.generatedAt).toBe(NOW.toISOString());
  });
});

describe("the query string", () => {
  const parse = (search: string) => parseAlertHistoryQuery(new URLSearchParams(search));

  it("reads absence and 'all' as unfiltered", () => {
    expect(parse("")).toEqual({
      asset: null,
      severity: null,
      offset: 0,
      limit: ALERT_HISTORY_PAGE,
      malformed: null,
    });
    expect(parse("asset=all&severity=all").asset).toBeNull();
    // An EMPTY param is absence, not a mistake: `?offset=` is what a form that
    // cleared its field produces, and it means the first page.
    expect(parse("offset=&limit=").malformed).toBeNull();
  });

  it("drops a severity the enum has never heard of rather than refusing the page", () => {
    // A stale bookmark narrows to nothing a rule can fire; answering 422 would
    // turn a mistyped filter into a broken page.
    expect(parse("severity=purple").severity).toBeNull();
    expect(parse("severity=error").severity).toBe("error");
  });

  it("clamps a page size it can read", () => {
    // A readable number that is out of range is still readable — the same
    // distinction /api/financials draws between a month with no rows and a
    // value that is not a month.
    expect(parse("limit=100000")).toMatchObject({
      limit: ALERT_HISTORY_MAX_LIMIT,
      malformed: null,
    });
    expect(parse("limit=0")).toMatchObject({ limit: 1, malformed: null,
    });
    expect(parse("offset=40")).toMatchObject({ offset: 40, malformed: null });
  });

  it("refuses a page param it cannot read, keeping the value verbatim", () => {
    // Bead `ro-oefa`: dropping these silently answered page one, which looks
    // exactly like the page a working link lands on.
    expect(parse("limit=abc").malformed).toEqual({ param: "limit", value: "abc" });
    expect(parse("offset=-4").malformed).toEqual({ param: "offset", value: "-4" });
    expect(parse("offset=1e99").malformed).toEqual({ param: "offset", value: "1e99" });
    expect(parse("offset=2.5").malformed).toEqual({ param: "offset", value: "2.5" });
    // `offset` leads when both are wrong: it is the one a shared link carries.
    expect(parse("offset=nonsense&limit=-4").malformed?.param).toBe("offset");
    // The defaults ride along, so the route can still count what it refuses.
    expect(parse("offset=nonsense")).toMatchObject({
      offset: 0,
      limit: ALERT_HISTORY_PAGE,
    });
  });

  it("asks the bad value again rather than serializing the default over it", () => {
    // Without this the browser would never SEE the refusal: the client rebuilds
    // its URL from the parsed query, so a clamped default here would turn the
    // corrupted link back into a request for page one.
    const search = alertHistoryQueryString(parse("offset=nonsense"));

    expect(new URLSearchParams(search).get("offset")).toBe("nonsense");
  });
});

describe("how long an alert was open", () => {
  it("measures from the onset to whichever closing time the row carries", () => {
    expect(
      alertOpenMs({ firstFiredAt: at(5), resolvedAt: at(2), dispositionAt: null }),
    ).toBe(3 * DAY);
    expect(
      alertOpenMs({ firstFiredAt: at(5), resolvedAt: null, dispositionAt: at(4) }),
    ).toBe(DAY);
    // Resolution wins when a row carries both: it is the later, final word.
    expect(
      alertOpenMs({ firstFiredAt: at(5), resolvedAt: at(1), dispositionAt: at(4) }),
    ).toBe(4 * DAY);
  });

  it("is unmeasurable rather than zero when nothing closed it", () => {
    expect(
      alertOpenMs({ firstFiredAt: at(5), resolvedAt: null, dispositionAt: null }),
    ).toBeNull();
  });
});

describe("the route", () => {
  const request = async (search = "", method = "GET") =>
    handleAlertHistoryRequest(
      new Request(`https://tower.local/api/alerts/history${search}`, { method }),
      new URL(`https://tower.local/api/alerts/history${search}`),
      test.call,
      { now: NOW },
    );

  it("answers a GET with the payload", async () => {
    await insertFlag(test, { asset: "nosh.example", firedAt: at(4), resolvedAt: at(3) });

    const res = await request();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it("reads its filters off the query string", async () => {
    await insertFlag(test, { asset: "meals.example", firedAt: at(9), resolvedAt: at(8) });
    await insertFlag(test, { asset: "nosh.example", firedAt: at(4), resolvedAt: at(3) });

    const res = await request("?asset=nosh.example");
    const body = (await res.json()) as { rows: { asset: { id: string } }[] };
    expect(body.rows.map((row) => row.asset.id)).toEqual(["nosh.example"]);
  });

  it("refuses anything but a read", async () => {
    const res = await request("", "POST");
    expect(res.status).toBe(405);
  });

  it("refuses a page param it cannot read, naming how much there is", async () => {
    // Bead `ro-oefa` — the answer /api/financials gives a malformed `?period=`,
    // and the count is this route's `periods[]`: a corrupted link comes back
    // with the size of the archive it was trying to page into.
    await insertFlag(test, { asset: "nosh.example", firedAt: at(4), resolvedAt: at(3) });
    await insertFlag(test, { asset: "meals.example", firedAt: at(9), resolvedAt: at(8) });

    const res = await request("?offset=nonsense");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      total: number;
      limit: number;
    };
    expect(body.error).toBe("page_malformed");
    expect(body.total).toBe(2);
    expect(body.limit).toBe(ALERT_HISTORY_PAGE);
  });

  it("counts the FILTERED archive in the refusal, not the whole store", async () => {
    // The number the reader is offered has to describe the list they were
    // paging through, exactly as the financials refusal names the months.
    await insertFlag(test, { asset: "nosh.example", firedAt: at(4), resolvedAt: at(3) });
    await insertFlag(test, { asset: "meals.example", firedAt: at(9), resolvedAt: at(8) });

    const res = await request("?asset=nosh.example&offset=-1");
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });
});

/**
 * OPEN, SNOOZED, SETTLED — every alert is in exactly one (beads `ro-c7qq`,
 * `ro-ujb9.194`).
 *
 * This read's predicate was once `resolved_at IS NOT NULL OR disposition IS NOT
 * NULL`, which listed an EXPIRED snooze here and on the Open view at once. It
 * then became "everything not open", which fixed that and filed every ACTIVE
 * snooze here instead — with the ✓ of a finished thing, while the Open view
 * listed the same row under Snoozed, and "Settled · 7d" counted it. A snooze is
 * put off, not decided. The three states now live together in
 * `@noticeos/contract`'s `flag-open.ts`, and what these tests pin is that each
 * row is in exactly one of them at any instant.
 */
describe("a snoozed alert is in exactly one list", () => {
  const settledIds = async (now: Date): Promise<number[]> =>
    (
      await buildAlertHistoryPayload(test.call, query(), { now })
    ).rows.map((row) => row.flag.id);

  it("leaves an ACTIVE snooze out — it is parked, not settled", async () => {
    // Bead `ro-ujb9.194` replaced "counts an ACTIVE snooze as settled": the
    // row it listed here was also under Open's Snoozed panel, and it came back
    // on its date as if nobody had settled anything — because nobody had.
    await insertFlag(test, {
      asset: "meals.example",
      firedAt: at(9),
      disposition: "snooze",
      dispositionAt: at(2),
      dispositionNote: "Snoozed by operator",
      // Four days after NOW.
      snoozeUntil: new Date(NOW.getTime() + 4 * DAY).toISOString(),
    });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });
    expect(payload.rows).toEqual([]);
    expect(payload.total).toBe(0);
  });

  it("leaves it out after the date passes too — it is OPEN again", async () => {
    await insertFlag(test, {
      asset: "meals.example",
      firedAt: at(9),
      disposition: "snooze",
      dispositionAt: at(5),
      dispositionNote: "Snoozed by operator",
      snoozeUntil: at(1), // yesterday
    });

    // The same row the Wall's attention rail now carries again. Listing it here
    // as well would put one alert on two pages that contradict each other.
    expect(await settledIds(NOW)).toEqual([]);
  });

  it("keeps a snoozed row that was then acknowledged, because ack does not expire", async () => {
    const acked = await insertFlag(test, {
      asset: "nosh.example",
      firedAt: at(9),
      disposition: "ack",
      dispositionAt: at(1),
      // `applyFlagAction` nulls this on ack; a stale one must not resurrect it.
      snoozeUntil: null,
    });

    expect(await settledIds(NOW)).toEqual([acked]);
  });

  it("keeps resolved, incident and hypothesis rows, and a snooze later resolved", async () => {
    const resolved = await insertFlag(test, { asset: "meals.example", firedAt: at(9), resolvedAt: at(8) });
    const incident = await insertFlag(test, {
      asset: "meals.example", firedAt: at(8), disposition: "incident", dispositionAt: at(7),
    });
    const hypothesis = await insertFlag(test, {
      asset: "meals.example", firedAt: at(7), disposition: "hypothesis", dispositionAt: at(6),
    });
    // Parked, then fixed before its date: resolving is a decision that does not
    // expire, whatever the row said before.
    const parkedThenFixed = await insertFlag(test, {
      asset: "nosh.example", firedAt: at(6), disposition: "snooze", dispositionAt: at(5),
      snoozeUntil: new Date(NOW.getTime() + 4 * DAY).toISOString(), resolvedAt: at(4),
    });

    expect((await settledIds(NOW)).sort((a, b) => a - b)).toEqual(
      [resolved, incident, hypothesis, parkedThenFixed].sort((a, b) => a - b),
    );
  });

  it("leaves a tuned alert out until it is settled another way", async () => {
    // Tuning the rule is not answering the firing (bead `ro-van6`): open.
    await insertFlag(test, { asset: "meals.example", firedAt: at(9), disposition: "tune", dispositionAt: at(8) });
    const tunedThenResolved = await insertFlag(test, {
      asset: "meals.example", firedAt: at(8), disposition: "tune", dispositionAt: at(7), resolvedAt: at(6),
    });

    expect(await settledIds(NOW)).toEqual([tunedThenResolved]);
  });

  it("puts every row in exactly one of open, snoozed and settled, at any instant", async () => {
    // Every shape the store can hold, with dates on either side of NOW.
    const later = new Date(NOW.getTime() + 4 * DAY).toISOString();
    const shapes: FlagSpec[] = [];
    for (const disposition of [null, "ack", "snooze", "tune", "incident", "hypothesis"] as const) {
      for (const snoozeUntil of [null, at(1), later]) {
        for (const resolvedAt of [null, at(2)]) {
          shapes.push({
            asset: "meals.example", firedAt: at(10), disposition,
            dispositionAt: disposition ? at(3) : null, snoozeUntil, resolvedAt,
          });
        }
      }
    }
    const ids: number[] = [];
    for (const spec of shapes) ids.push(await insertFlag(test, spec));
    const read = async (where: string, binds: string[]) =>
      (await readAlerts(test.call, where, binds)).map((row) => row.id);
    const nowIso = NOW.toISOString();
    const open = await read(openFlagsSql("", "$1::timestamptz"), [nowIso]);
    const snoozed = await read(snoozedFlagsSql("", "$1::timestamptz"), [nowIso]);
    const settled = await read(settledFlagsSql(), []);

    ids.forEach((id, index) => {
      const states = [open.includes(id), snoozed.includes(id), settled.includes(id)].filter(Boolean);
      expect(states, `flag ${id} ${JSON.stringify(shapes[index])}`).toHaveLength(1);
    });
    // And the History read is the settled state, nothing more and nothing less.
    const history = await buildAlertHistoryPayload(
      test.call,
      query({ limit: ALERT_HISTORY_MAX_LIMIT }),
      { now: NOW },
    );
    expect(history.rows.map((row) => row.flag.id).sort((a, b) => a - b))
      .toEqual([...settled].sort((a, b) => a - b));
  });
});

describe("a settled outage reads back night by night (ro-ujb9.220)", () => {
  async function insertReading(db: TestStore, flagId: number, observedAt: string, error: string): Promise<void> {
    await storeReading(db.call, flagId, {
      observedAt,
      severity: "warn",
      message: `pull failed: ${error}`,
      ruleInputs: { rule: "asset-pull-failed", error },
    });
  }

  it("carries each stored reading on its alert, newest first, and none on an alert without", async () => {
    const outage = await insertFlag(test, {
      asset: "nosh.example", firedAt: at(5), ruleId: "asset-pull-failed", resolvedAt: at(3),
    });
    await insertReading(test, outage, at(5), "503 unconfigured");
    await insertReading(test, outage, at(4), "401 unauthorized");
    const other = await insertFlag(test, { asset: "meals.example", firedAt: at(6), resolvedAt: at(2) });

    const payload = await buildAlertHistoryPayload(test.call, query(), { now: NOW });
    const byId = new Map(payload.rows.map((row) => [row.flag.id, row.flag]));
    expect(byId.get(outage)?.readings?.map((reading) => reading.ruleInputs?.error))
      .toEqual(["401 unauthorized", "503 unconfigured"]);
    expect(byId.get(other)).not.toHaveProperty("readings");
  });
});
