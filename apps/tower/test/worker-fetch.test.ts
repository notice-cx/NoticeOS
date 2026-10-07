// @vitest-environment node
import { readSite, readSites } from "../worker/asset-registry";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type TowerEnv } from "../worker/index";
import { CONFIG_STORE_NOT_READY_REASON } from "../worker/config-route";
import { ALERT_HISTORY_PAGE } from "../shared/alert-history";
import { READ_ONLY_DEPLOYMENT } from "../shared/tasks";
import { READ_ONLY_TASKS_REFUSAL } from "../worker/tasks-route";
import { readAlert, storeAlert } from "./alert-rows";
import { createTestStore, type TestStore, postgresUnavailable } from "./postgres-store";
import { bookLedger } from "./money";
import { addSites } from "./sites";


// THE WORKER'S OWN FETCH SWITCH (bead ro-ap7n).
//
// Every other Tower worker test targets a sub-module — buildFinancialsPayload,
// buildWallPayload, handleWatchWindowRequest — so path matching, query-parameter
// validation, and the status codes the catch blocks emit were untested by
// construction: nothing imported `worker/index.ts` at all. The client tests are
// no substitute. `test/financials-route.test.tsx` stubs `fetch` and proves the
// PAGE reads a body of the right shape; nothing proved the Worker emits one.
//
// This file stays at the switch's altitude on purpose. What each payload
// CONTAINS is already pinned by test/financials-payload.test.ts and its
// siblings; what is pinned here is which request gets which status and which
// error code, which is the half a page renders its recovery state from.
//
// `/api/financials` is the branch that made the gap visible (bead ro-dm67): a
// malformed `?period=` is no longer refused before the store is read, because
// both refusals now carry the months that DO exist. A 400 and a 404 that each
// hand back `periods[]` are two lines of routing logic with no test between
// them and the operator's dead bookmark.

const NOW = new Date("2026-08-15T12:00:00.000Z");

/**
 * The build-time config `vite.config.ts` injects with `define`.
 *
 * Vitest loads `vitest.config.ts`, which has no `define` — deliberately, since
 * these suites test the payload builders by passing config in as parameters.
 * The fetch switch is the one module that reads the injected values, so it gets
 * them here: empty stand-ins, because no assertion below depends on their
 * content, and an empty one cannot be mistaken for the repo's real config.
 */
const INJECTED: Record<string, unknown> = {
  __MONTHLY_CAPS__: { dataUsd: 0 },
  __FLAG_DEFAULTS__: {},
  __PULL_CONFIG__: [],
  __OPERATOR_RATE__: 0,
  __INTEGRATIONS__: { catalog: [], assets: {} },
  __COUNTERS__: { assets: {} },
  __DASHBOARD__: {},
  __OS_TIME_ZONE__: "UTC",
  __NO_NIGHTLY_REPORT__: null,
  __SCHEDULES__: null,
  __SERP_PANEL__: { assets: {} },
  __SIGNAL_PANELS__: { assets: {} },
  __VALUE_EVENTS__: { assets: {} },
  __GA4_EVENT_PARAMS__: { assets: {} },
  __DOMAIN_COSTS__: [],
  __RECURRING_COSTS__: [],
  __ENTITIES__: [],
  __BEADS__: { spokes: [] },
  // A build substitutes `false` here, so the runner lane is dead code in every
  // deployed bundle. These are the deployed answers.
  __RUNNER_LANE__: false,
};

/**
 * Every INGEST RPC the switch reached during one case, in order.
 *
 * The proxied write routes (`PATCH /api/assets/:id`, `POST
 * /api/assets`) DO call ingest when a request gets that far, so "it refused"
 * cannot be read off the status alone — a binding failure comes back 500, and
 * the cross-origin refusal has to be provably earlier than the binding. This is
 * how a case says *nothing left the Worker*.
 */
const ingestCalls: string[] = [];

/**
 * The INGEST Service Binding, as a double that REFUSES.
 *
 * The read routes exercised below never proxy to ingest — they read the store
 * or answer from the path alone — so any call from one of them is the switch
 * having sent a request somewhere it was not meant to go, and the name in the
 * message says which one. A binding that quietly returned `undefined` would let
 * that pass as a 500. For the write routes it is the other half of the same
 * point: a request that clears the origin guard reaches this and fails loudly,
 * so a case asserting 403 is asserting the guard came FIRST.
 *
 * Every RPC in `TowerEnv["INGEST"]` is named here, in one place, so a route that
 * starts calling a new one widens this too rather than getting an undefined.
 */
function refusingIngest(): TowerEnv["INGEST"] {
  const refuse =
    (rpc: string) =>
    (): never => {
      ingestCalls.push(rpc);
      throw new Error(
        `the fetch switch called INGEST.${rpc}(); no route under test proxies to ingest`,
      );
    };
  return {
    // The ONE exception, and it is not an exception to the rule above: every
    // read route resolves its config through this now (epic `ro-syok`), so a
    // refusal here would say "the switch proxied" about every case in the file.
    // It answers as an UNSEEDED store — the compiled config, which is what these
    // cases have always been written against.
    getConfigDocuments: async (files: string[]) =>
      files.map((file) => ({
        file,
        body: null,
        source: "file" as const,
        version: null,
        updatedAt: null,
        updatedBy: null,
      })),
    applyConfigOps: refuse("applyConfigOps"),
    mediavineStatus: refuse('mediavineStatus'),
    saveMediavineSettings: refuse('saveMediavineSettings'),
    syncMediavine: refuse('syncMediavine'),
    discoverSites: refuse("discoverSites"),
    collectNow: refuse("collectNow"),
    createAnnotation: refuse("createAnnotation"),
    readAssetState: refuse("readAssetState"),
    writeAssetColumn: refuse("writeAssetColumn"),
    createAsset: refuse("createAsset"),
    moveAsset: refuse("moveAsset"),
    calendarUpcoming: refuse("calendarUpcoming"),
    researchLookup: refuse("researchLookup"),
    runScheduled: refuse("runScheduled"),
    fetch: refuse("fetch"),
    watchQueryHistory: refuse("watchQueryHistory"),
    setCredentialExpiry: refuse("setCredentialExpiry"),
    createWatchWindow: refuse("createWatchWindow"),
    backtestRule: refuse("backtestRule"),
    listCredentialSummaries: refuse("listCredentialSummaries"),
    putCredential: refuse("putCredential"),
    deleteCredential: refuse("deleteCredential"),
    probeCredential: refuse("probeCredential"),
    connectCredential: refuse("connectCredential"),
    cloudflareD1: refuse('cloudflareD1'),
    backupCloudflareD1: refuse('backupCloudflareD1'),
    putSiteToken: refuse("putSiteToken"),
    beginGoogleOAuth: refuse("beginGoogleOAuth"),
    completeGoogleOAuth: refuse("completeGoogleOAuth"),
    discoverGoogleProperties: refuse("discoverGoogleProperties"),
    ga4Realtime: refuse("ga4Realtime"),
  };
}

let ctx: TestStore;
let env: TowerEnv;

/** A site in both stores the Worker reads (test/sites.ts). */
async function asset(raw: TestStore, id: string, name: string): Promise<void> {
  await addSites(raw, [{ id, domain: null, displayName: name, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" }]);
}

/** The money the cases read, on Postgres (bead ro-ujb9.76.6.1): the same in
 * every case and only ever read, so booked once into this file's copy. */
const LEDGER = [
  { kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", minor: 30000 },
  { kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", minor: 44094 },
  { kind: "cost", asset: "meals.example", period: "2026-08", family: "api", minor: 305 },
] as const;
async function bookLedgerOnce(): Promise<void> {
  if (!pg) return;
  await bookLedger(pg.call, LEDGER.map((row) => ({
    kind: row.kind, asset: row.asset, period: row.period, family: row.family, amount_minor: row.minor,
    booking_state: "estimated" as const, recorded_at: "2026-08-15T00:00:00.000Z" })));
}

/** An alert number this file's store never hands out: a case about an alert
 * that is NOT there. */
const NO_SUCH_ALERT = 404_404;

/** A same-origin request, the way the browser sends one: no `origin` header. */
function get(path: string): Request {
  return new Request(`https://tower.test${path}`);
}

/** A write the browser sends from the Tower's own page: the two headers a
 * same-origin `fetch` actually sets, plus a JSON body. */
function sameOrigin(path: string, method: string, body?: string): Request {
  return new Request(`https://tower.test${path}`, {
    method,
    headers: {
      origin: "https://tower.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body,
  });
}

/** The same write, sent from somewhere else. */
function crossOrigin(path: string, method: string, body?: string): Request {
  return new Request(`https://tower.test${path}`, {
    method,
    headers: {
      origin: "https://elsewhere.test",
      "content-type": "application/json",
    },
    body,
  });
}

/** A call's context: the Worker closes its call's store through it. */
const CALL_CONTEXT = { waitUntil: (work: Promise<unknown>) => void work.catch(() => undefined) };

/** One request through the real switch, plus the two things every case asserts
 * on: the status, and the JSON body the page branches on. */
async function call(
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(request, env, CALL_CONTEXT);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(() => {
  for (const [name, value] of Object.entries(INJECTED)) vi.stubGlobal(name, value);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await pg?.close();
});

/** This file's copy of the run's throwaway Postgres, what the Worker's POSTGRES
 * binding names (epic ro-ujb9.76), or none where no Postgres can start here. */
const unavailable = postgresUnavailable();
let pg: TestStore | undefined;


beforeEach(async () => {
  // The switch reads `new Date()` itself — there is no clock to inject — and
  // "the latest month with rows" is answered against it. Freezing the clock is
  // what keeps the 404 case a MISSING month rather than a future one. Only the
  // clock: the Postgres driver's own timers keep running.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  ingestCalls.length = 0;
  ctx = await createTestStore();
  pg = ctx;
  await asset(ctx, "meals.example", "Meal Planner");
  await bookLedgerOnce();

  env = { NOTICEOS_WORKSPACE_PROFILE: 'standalone', INGEST: refusingIngest(), ...(pg ? { POSTGRES: { connectionString: pg.url } } : {}) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Worker's fetch switch", () => {
  it('refuses foreign-origin D1 selection and export before forwarding to ingest', async () => {
    const path = '/api/integrations/cloudflare/d1', accountId = 'a'.repeat(32), databaseId = crypto.randomUUID();
    for (const [method, body] of [['PUT', { version: 1, accountId, targets: [{ databaseId, asset: 'example.com' }] }], ['POST', { accountId, databaseId }]] as const) {
      expect(await call(crossOrigin(path, method, JSON.stringify(body)))).toEqual({ status: 403, body: { error: 'forbidden' } });
    }
    expect(ingestCalls).toEqual([]);
  });
  describe("/api/financials", () => {
    it("answers 200 with the payload for a month the ledger holds", async () => {
      const { status, body } = await call(get("/api/financials?period=2026-07"));

      expect(status).toBe(200);
      expect(body.period).toBe("2026-07");
      expect(body.periods).toEqual(["2026-07", "2026-08"]);
      expect(body.empty).toBe(false);
    });

    it("picks the latest month with rows when no period is asked for", async () => {
      const { status, body } = await call(get("/api/financials"));

      expect(status).toBe(200);
      expect(body.period).toBe("2026-08");
    });

    it("refuses a well-formed month with no rows as 404 period_not_found, carrying the months that exist", async () => {
      const { status, body } = await call(get("/api/financials?period=2026-05"));

      expect(status).toBe(404);
      expect(body.error).toBe("period_not_found");
      // The whole point of the refusal: a dead bookmark lands one click from a
      // live month rather than on "the ledger did not answer".
      expect(body.periods).toEqual(["2026-07", "2026-08"]);
    });

    it("refuses a malformed value as 400 period_malformed, carrying the same months", async () => {
      const { status, body } = await call(get("/api/financials?period=august"));

      expect(status).toBe(400);
      expect(body.error).toBe("period_malformed");
      expect(body.periods).toEqual(["2026-07", "2026-08"]);
    });

    it("reads the store even for a malformed value, which is what lets it name the months", async () => {
      // Not a redundant restatement of the case above: it pins the ORDER the
      // route runs in. Refusing before the read — the pre-ro-dm67 behaviour —
      // still answers 400, and would still pass the assertion on `error`.
      const { body } = await call(get("/api/financials?period=13"));

      expect(body.periods).not.toEqual([]);
    });
  });

  describe("the paths that answer without touching the store", () => {
    it("answers /api/health 200", async () => {
      const { status, body } = await call(get("/api/health"));

      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
    });

    it("answers an unknown /api/* path 404 not_found", async () => {
      const { status, body } = await call(get("/api/nothing-here"));

      expect(status).toBe(404);
      expect(body).toEqual({ error: "not_found" });
    });

    it("refuses a cross-origin write 403 before it reads the body", async () => {
      const request = new Request(`https://tower.test/api/flags/${NO_SUCH_ALERT}`, {
        method: "PATCH",
        headers: {
          origin: "https://elsewhere.test",
          "content-type": "application/json" },
        body: JSON.stringify({ action: "acknowledge" }) });

      const { status, body } = await call(request);

      expect(status).toBe(403);
      expect(body).toEqual({ error: "forbidden" });
    });

    it("lets a same-origin write past the origin guard", async () => {
      // The other side of the guard: without it, the 403 above could be any
      // refusal at all. No alert has that number, so the write reaches the
      // store and comes back 409 flag_not_open — past the guard, and no further.
      const request = new Request(`https://tower.test/api/flags/${NO_SUCH_ALERT}`, {
        method: "PATCH",
        headers: {
          origin: "https://tower.test",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json" },
        body: JSON.stringify({ action: "acknowledge" }) });

      const { status, body } = await call(request);

      expect(status).toBe(409);
      expect(body).toEqual({ error: "flag_not_open" });
    });
  });

  // ── the read models the desk and the Wall poll (bead ro-gg26) ─────────────
  //
  // Each of these has a payload test of its own. What none of them had is a
  // test that the SWITCH answers on that path at all — a route deleted, renamed
  // or shadowed by a pattern above it would leave every payload test green and
  // every page empty.
  describe("the read models", () => {
    it("answers /api/wall 200 with the assembled payload", async () => {
      const { status, body } = await call(get("/api/wall"));

      expect(status).toBe(200);
      expect(typeof body.generatedAt).toBe("string");
      expect(Array.isArray(body.assets)).toBe(true);
    });

    it.skipIf(unavailable !== null)("answers /api/wall/feed 200 with the feed, apart from /api/wall", async () => {
      const { status, body } = await call(get("/api/wall/feed"));

      expect(status).toBe(200);
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.since).toBe("string");
      expect(body.limit).toBe(50);
    });

    it("answers /api/settings 200 without reading the store", async () => {
      const { status, body } = await call(get("/api/settings"));

      expect(status).toBe(200);
      // A pure builder over the injected config: the page an operator opens to
      // fix something must not go blank because the store is empty.
      expect(body.clock).toBeDefined();
      expect(body.budget).toBeDefined();
      expect(body.taskHub).toBeDefined();
    });

    it("answers /api/integrations 200 with the portfolio matrix", async () => {
      const { status, body } = await call(get("/api/integrations"));

      expect(status).toBe(200);
      expect(body.generatedAt).toBeDefined();
    });

    it("answers /api/work 200 with an empty board when no snapshot has landed", async () => {
      const { status, body } = await call(get("/api/work"));

      expect(status).toBe(200);
      expect(body.capturedAt).toBeNull();
      expect(body.projects).toEqual([]);
    });

    // D32 (bead ro-ujb9.143): the compiled config saves no task project and no
    // snapshot has landed, so no task source is connected — every task screen
    // stays away, and Integrations offers the beads source's Connect.
    it("answers /api/task-source 200 with no task source connected", async () => {
      const { status, body } = await call(get("/api/task-source"));

      expect(status).toBe(200);
      expect(body).toEqual({
        connected: null,
        sources: [{ id: "beads", connected: false, projects: 0, readAt: null, failing: 0 }],
      });
    });

    it("answers /api/alerts/history 200 with the first page", async () => {
      const { status, body } = await call(get("/api/alerts/history"));

      expect(status).toBe(200);
      // Flag 7 is open, so the settled archive is empty — and an empty archive
      // is a page, not an error.
      expect(body.rows).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(ALERT_HISTORY_PAGE);
    });

    it("dispatches /api/mcp to the MCP route rather than the 404 at the bottom", async () => {
      // The switch's half of `/api/mcp`, and no more. What the tools RETURN is
      // pinned by test/mcp-route.test.ts, and getting there means a JSON-RPC
      // handshake — `initialize`, then `notifications/initialized`, then a
      // call — which is a transport conversation, not a routing fact. A GET
      // proves the routing: the MCP route refuses it with a 405 in JSON-RPC,
      // where an unrouted path would come back `{ error: "not_found" }` with a 404.
      const { status, body } = await call(get("/api/mcp"));

      expect(status).toBe(405);
      expect(body.jsonrpc).toBe("2.0");
      expect((body.error as { code: number }).code).toBe(-32600);
    });

    it("refuses a page param it cannot read, the way /api/financials refuses a month", async () => {
      // The two routes AGREE. Both params arrive from a URL the operator can
      // share, edit and bookmark, so both refuse what they cannot read and both
      // carry back what does exist — `periods[]` there, the size of the archive
      // here. Silently answering page one made a corrupted link look exactly
      // like one that worked.
      const { status, body } = await call(
        get("/api/alerts/history?offset=nonsense&limit=-4"),
      );

      expect(status).toBe(400);
      expect(body.error).toBe("page_malformed");
      expect(body.total).toBe(0);
      expect(body.limit).toBe(ALERT_HISTORY_PAGE);
    });
  });

  describe("the asset drill-down", () => {
    it("answers 200 for an asset the store has", async () => {
      const { status, body } = await call(get("/api/assets/meals.example"));

      expect(status).toBe(200);
      expect((body.asset as { id: string }).id).toBe("meals.example");
    });

    it("answers 404 asset_not_found for one it does not, naming the id", async () => {
      const { status, body } = await call(get("/api/assets/nowhere.test"));

      expect(status).toBe(404);
      expect(body).toEqual({ error: "asset_not_found", id: "nowhere.test" });
    });

    it("answers 404 not_found for an empty id", async () => {
      const { status, body } = await call(get("/api/assets/"));

      expect(status).toBe(404);
      expect(body).toEqual({ error: "not_found" });
    });

    it("answers 404 not_found for a slash in the id", async () => {
      // Asset ids contain dots, never slashes, so the whole path remainder is
      // the id — and a remainder with a slash in it is a sub-path nothing
      // above claimed, not an asset.
      const { status, body } = await call(get("/api/assets/meals.example/nonsense"));

      expect(status).toBe(404);
      expect(body).toEqual({ error: "not_found" });
    });

    // One read per tab (bead ro-ujb9.64): `?view=` names the tab being drawn.
    it("answers one tab's view, named, without the sections it does not draw", async () => {
      const { status, body } = await call(get("/api/assets/meals.example?view=alerts"));

      expect(status).toBe(200);
      expect(body.view).toBe("alerts");
      expect((body.asset as { id: string }).id).toBe("meals.example");
      expect(body).toHaveProperty("flags");
      expect(body).not.toHaveProperty("performance");
      expect(body).not.toHaveProperty("ledger");
    });

    it("answers the whole page, unnamed, with no view", async () => {
      const { body } = await call(get("/api/assets/meals.example"));

      expect(body).not.toHaveProperty("view");
      expect(body).toHaveProperty("performance");
      expect(body).toHaveProperty("ledger");
    });

    it("refuses a view no tab has, 400, rather than guessing one", async () => {
      const { status, body } = await call(get("/api/assets/meals.example?view=everything"));

      expect(status).toBe(400);
      expect(body).toEqual({ error: "unknown_view", view: "everything" });
    });

    it("still answers 404 for an unknown asset whatever the view", async () => {
      const { status } = await call(get("/api/assets/nowhere.test?view=overview"));

      expect(status).toBe(404);
    });
  });

  // ── what a DEPLOYED build says it cannot do ───────────────────────────────
  //
  // Locally the dev server's lanes answer these paths first and do the work
  // (config-write-lane.ts and task-lane.ts, both `enforce: "pre"`). What the
  // Worker holds is the deployed answer, and it is the half no local run ever
  // exercises — so it is the half most likely to rot.
  describe("deployed configuration and task capabilities", () => {
    it("enables configuration editing after a successful store read and names fallback values", async () => {
      const { status, body } = await call(get("/api/config"));

      expect(status).toBe(200);
      // The store answered successfully; a missing document uses the compiled
      // value and does not imply a missing database table.
      expect(body).toMatchObject({
        writable: true,
        reason: null,
      });
      // And it says, per file, where the value the page rendered came from.
      expect((body as { sources: Record<string, string> }).sources["config/tower.json"]).toBe(
        "file",
      );
    });

    it("sends a configuration write to ingest and reports its connection failure safely", async () => {
      await expect(
        call(sameOrigin("/api/config", "PUT", JSON.stringify({ ops: [] }))),
      ).resolves.toEqual({ status: 503, body: { error: "store_unavailable", detail: CONFIG_STORE_NOT_READY_REASON } });
      expect(ingestCalls).toContain("applyConfigOps");
    });

    it("says on /api/tasks/capabilities that the hub is not live here", async () => {
      const { status, body } = await call(get("/api/tasks/capabilities"));

      expect(status).toBe(200);
      expect(body).toEqual({ live: false, reason: READ_ONLY_DEPLOYMENT });
    });

    it("refuses every other task path 501 with the reason, reads included", async () => {
      for (const path of ["/api/tasks", "/api/tasks/ro-1234", "/api/gates/ro-1234"]) {
        const { status, body } = await call(get(path));

        expect(status, path).toBe(501);
        expect(body, path).toEqual({
          error: "read_only_deployment",
          detail: READ_ONLY_TASKS_REFUSAL,
        });
      }
    });
  });

  describe.skipIf(unavailable !== null)("PATCH /api/flags/:id", () => {
    /** One OPEN condition, on Postgres (bead ro-ujb9.76.5.2): this file's store
     * numbers it, so each case names the alert by what it got back. */
    let id: number;
    beforeEach(async () => {
      id = await storeAlert(pg!.call, {
        asset: "meals.example",
        firedAt: "2026-08-14T09:00:00.000Z",
        severity: "warn",
        kind: "anomaly",
        metric: "clicks",
        message: "a condition",
        ruleId: "clicks-drop",
      });
    });
    const disposition = async () => ({ disposition: (await readAlert(pg!.call, id))!.disposition });

    it("dispositions an open flag 200", async () => {
      const { status, body } = await call(
        sameOrigin(`/api/flags/${id}`, "PATCH", JSON.stringify({ action: "acknowledge" })),
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      // The store moved, which is the half a 200 alone would not prove.
      expect(await disposition()).toEqual({ disposition: "ack" });
    });

    it("refuses a cross-origin disposition 403", async () => {
      const { status, body } = await call(
        crossOrigin(`/api/flags/${id}`, "PATCH", JSON.stringify({ action: "acknowledge" })),
      );

      expect(status).toBe(403);
      expect(body).toEqual({ error: "forbidden" });
      expect(await disposition()).toEqual({
        disposition: null,
      });
    });

    it("refuses a body it cannot parse 400", async () => {
      const { status, body } = await call(sameOrigin(`/api/flags/${id}`, "PATCH", "{not json"));

      expect(status).toBe(400);
      expect(body).toEqual({ error: "bad_request" });
    });
  });

  // ── the writes that leave the Worker ──────────────────────────────────────
  //
  // These two DO proxy to ingest when a request gets that far, so the status
  // alone cannot say the origin guard ran: a binding failure is a 500 and would
  // look like refusal on the client side too. `ingestCalls` is what makes the
  // assertion real — nothing left the Worker, and nothing in the store moved.
  describe("the ingest-proxied writes", () => {
    it("refuses a cross-origin PATCH /api/assets/:id 403 before the binding", async () => {
      const { status, body } = await call(
        crossOrigin(
          "/api/assets/meals.example",
          "PATCH",
          JSON.stringify({ column: "status", expect: "live", value: "retired" }),
        ),
      );

      expect(status).toBe(403);
      expect(body).toEqual({ error: "forbidden" });
      expect(ingestCalls).toEqual([]);
      expect(await readSite(ctx.call, "meals.example")).toMatchObject({ status: "live" });
    });

    it("refuses a cross-origin POST /api/assets 403 before the binding", async () => {
      const { status, body } = await call(
        crossOrigin(
          "/api/assets",
          "POST",
          JSON.stringify({ id: "elsewhere.test", displayName: "Elsewhere" }),
        ),
      );

      expect(status).toBe(403);
      expect(body).toEqual({ error: "forbidden" });
      expect(ingestCalls).toEqual([]);
      expect(await readSites(ctx.call)).toHaveLength(1);
    });

    // No DELETE (bead ro-ujb9.76.4.5): a site is archived, never deleted. The
    // verb is refused rather than read as the GET beside it, so a page loaded
    // before the Delete card went cannot take a 200 for "deleted".
    it("refuses DELETE /api/assets/:id 405, reading and removing nothing", async () => {
      const response = await worker.fetch(sameOrigin("/api/assets/meals.example", "DELETE"), env, CALL_CONTEXT);

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, PATCH");
      expect(await response.text()).toBe("");
      expect(ingestCalls).toEqual([]);
      expect(await readSites(ctx.call)).toHaveLength(1);
    });
  });
});

it('the fixed native backup path forwards only standalone machine requests before opening Tower SQL', async () => {
  const saved = { ok: true };
  const rpc = vi.fn(async (original: Request) => {
    expect(original.url).toBe('https://tower.test/api/backup/cloudflare-d1');
    expect(original.headers.get('authorization')).toBe('Bearer synthetic');
    return Response.json(saved);
  });
  env.INGEST.backupCloudflareD1 = rpc;
  const response = await call(new Request('https://tower.test/api/backup/cloudflare-d1', { headers: { authorization: 'Bearer synthetic' } }));
  expect(response).toEqual({ status: 200, body: saved }); expect(rpc).toHaveBeenCalledTimes(1);
});
it('browser, hosted and demo requests never reach the machine backup receiver', async () => {
  const rpc = vi.fn(async () => Response.json({})); env.INGEST.backupCloudflareD1 = rpc;
  expect((await call(sameOrigin('/api/backup/cloudflare-d1', 'POST', '{}'))).status).toBe(403);
  for (const profile of ['hosted', 'demo'] as const) {
    env.NOTICEOS_WORKSPACE_PROFILE = profile;
    expect((await call(new Request('https://tower.test/api/backup/cloudflare-d1'))).status).toBe(403);
  }
  expect(rpc).not.toHaveBeenCalled();
});
