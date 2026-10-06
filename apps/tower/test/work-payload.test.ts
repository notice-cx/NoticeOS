// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  WORK_OWNER,
  WORK_POLL_CADENCE_HOURS,
  emptyWorkHistory,
  hasWork,
  priorityLabel,
  sumWorkHistory,
  type WorkCountsHistory,
  type WorkProject,
} from "../shared/work";
import { buildWorkPayload } from "../worker/work-payload";
import { type TestStore, createTestStore } from "./postgres-store";
import { addSites } from "./sites";

const NOW = new Date("2026-08-01T12:00:00.000Z");

let store: TestStore;

beforeEach(async () => {
  store = await createTestStore();
  await addSites(store, [
    // The owner's store still holds the pre-rename name for the OS row; the
    // OS's own project is named NoticeOS all the same (bead ro-ujb9.77.10).
    { id: "root-os", domain: null, displayName: "ReindexOS", status: "live", senseOnly: 1, isOs: 1, createdAt: "2026-07-01T00:00:00.000Z" },
    { id: "meals.example", displayName: "Meal Planner", status: "live", senseOnly: 0, createdAt: "2026-07-01T00:00:00.000Z" },
  ]);
});

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: "mp-1w2",
    title: "Fix the recipe schema",
    status: "open",
    priority: 1,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-08-01T11:55:00.000Z",
    closedAt: null,
    parent: "zz-epc",
    deferUntil: null,
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    asset: "meals.example",
    prefix: "mp",
    ok: true,
    error: null,
    counts: { open: 4, highPriority: 2, ready: 2, inProgress: 1, blocked: 2, closedRecent: 1, deferred: 0, waiting: 0 },
    ready: [issue(), issue({ id: "mp-88x", priority: 3 })],
    inProgress: [issue({ id: "mp-33j", status: "in_progress", assignee: "agent-x" })],
    recentlyClosed: [
      issue({ id: "mp-0pb", status: "closed", closedAt: "2026-07-31T18:00:00.000Z" }),
    ],
    ...overrides,
  };
}

/** One photograph, its payload as stored, in this test's own Postgres copy of
 * its sites (on Postgres since bead ro-ujb9.76.4.3; test/sites.ts). */
async function seedPayload(capturedAt: string, payload: unknown): Promise<void> {
  await (store.call).write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload) VALUES ($1::uuid, $2::timestamptz, $3::jsonb)`,
      [tx.workspaceId, capturedAt, JSON.stringify(payload)],
    ),
  );
}

async function seed(capturedAt: string, projects: unknown[]): Promise<void> {
  return seedPayload(capturedAt, { projects });
}

describe("buildWorkPayload", () => {
  it("renders the newest snapshot and says when it was taken", async () => {
    await seed("2026-08-01T11:59:00.000Z", [project()]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.generatedAt).toBe("2026-08-01T12:00:00.000Z");
    expect(payload.capturedAt).toBe("2026-08-01T11:59:00.000Z");
    expect(payload.owner).toBe(WORK_OWNER);
    expect(payload.pollCadenceHours).toBe(WORK_POLL_CADENCE_HOURS);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]).toMatchObject({
      asset: "meals.example",
      prefix: "mp",
      name: "Meal Planner",
      ok: true,
      error: null,
      counts: { open: 4, highPriority: 2, ready: 2, inProgress: 1, blocked: 2, closedRecent: 1, deferred: 0, waiting: 0 },
    });
    expect(payload.projects[0]!.ready.map((i) => i.id)).toEqual(["mp-1w2", "mp-88x"]);
    expect(payload.projects[0]!.inProgress[0]!.assignee).toBe("agent-x");
    expect(payload.projects[0]!.recentlyClosed[0]!.closedAt).toBe("2026-07-31T18:00:00.000Z");
  });

  // Only the latest row is read. Showing an older snapshot when the newest one
  // is stale would hide exactly the failure the age chip exists to reveal.
  it("reads only the latest snapshot, never a merge of the week", async () => {
    await seed("2026-07-30T09:00:00.000Z", [project({ counts: { open: 99, highPriority: 0, ready: 99, inProgress: 99, blocked: 99, closedRecent: 99, deferred: 0, waiting: 0 } })]);
    await seed("2026-08-01T11:59:00.000Z", [project()]);
    await seed("2026-07-31T09:00:00.000Z", [project({ asset: "nosh.example", prefix: "nom" })]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.capturedAt).toBe("2026-08-01T11:59:00.000Z");
    expect(payload.projects.map((p) => p.asset)).toEqual(["meals.example"]);
    expect(payload.projects[0]!.counts.ready).toBe(2);
  });

  it("keeps the snapshot's project order, which is the task map's order", async () => {
    await seed("2026-08-01T11:59:00.000Z", [
      project({ asset: "root-os", prefix: "ro", counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 }, ready: [], inProgress: [], recentlyClosed: [] }),
      project(),
    ]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    // A busy project must not float to the top just because it is busy.
    expect(payload.projects.map((p) => p.asset)).toEqual(["root-os", "meals.example"]);
  });

  it("names a project the store has never heard of by its own id", async () => {
    await seed("2026-08-01T11:59:00.000Z", [project({ asset: "ghost.site", prefix: "gh" })]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    // Dropping it would hide a config drift instead of showing it.
    expect(payload.projects[0]).toMatchObject({ asset: "ghost.site", name: "ghost.site" });
  });

  it("carries a failed project's reason and none of its work", async () => {
    await seed("2026-08-01T11:59:00.000Z", [
      project(),
      {
        asset: "root-os",
        prefix: "ro",
        ok: false,
        error: "bd ready exited 1: no beads project found",
        counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
        ready: [],
        inProgress: [],
        recentlyClosed: [],
      },
    ]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.projects[1]).toMatchObject({
      asset: "root-os",
      name: "NoticeOS",
      ok: false,
    });
    expect(payload.projects[1]!.error).toMatch(/no beads project found/);
    expect(payload.projects[1]!.ready).toEqual([]);
  });

  it("returns a fully-formed first-run payload when nothing has ever been filed", async () => {
    const payload = await buildWorkPayload(store.call, { now: NOW });

    // Callers branch on loading/error only — never on a missing section.
    expect(payload.capturedAt).toBeNull();
    expect(payload.projects).toEqual([]);
    expect(payload.owner).toBe(WORK_OWNER);
  });

  // The row outlives the code that wrote it. A board that throws on a payload
  // from an older poller goes dark exactly when someone changed something. The
  // store holds only JSON objects, so the unreadable part is its shape.
  it("degrades rather than throwing on a payload it cannot read", async () => {
    await seedPayload("2026-08-01T11:00:00.000Z", { projects: "not a list" });

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.capturedAt).toBe("2026-08-01T11:00:00.000Z");
    expect(payload.projects).toEqual([]);
  });

  it("skips a project entry with no asset id and keeps the rest", async () => {
    await seed("2026-08-01T11:59:00.000Z", [{ prefix: "??", ok: true }, project()]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.projects.map((p) => p.asset)).toEqual(["meals.example"]);
  });

  it("fills in what an older poller did not send", async () => {
    await seed("2026-08-01T11:59:00.000Z", [
      { asset: "meals.example", ok: true, ready: [{ id: "mp-999" }] },
    ]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.projects[0]).toMatchObject({ prefix: "?", name: "Meal Planner" });
    // The status counts default to 0 — they have been in the payload since the
    // table existed, so a missing one means an unreadable row, which is what
    // this whole degradation covers. `highPriority` is the exception: it
    // arrived on 2026-08-01, its absence is an ordinary fact about an older
    // poller rather than damage, and it stays null all the way to the chip so
    // nothing can render it as a measured zero.
    expect(payload.projects[0]!.counts).toEqual({
      open: 0,
      highPriority: null,
      ready: 0,
      inProgress: 0,
      blocked: 0,
      closedRecent: 0,
      deferred: null,
      waiting: null,
    });
    expect(payload.projects[0]!.ready[0]).toMatchObject({
      id: "mp-999",
      title: "mp-999",
      status: "open",
      priority: 2,
      issueType: "task",
      assignee: null,
    });
  });
});

// Byte-for-byte what `POST /api/beads-snapshot` writes into `payload` for one
// real poller run (bd 1.1.2 against the live hub, 2026-08-01). Duplicated
// verbatim in `workers/ingest/test/beads-snapshot.test.ts`, which asserts the
// route produces exactly this — the two packages cannot import each other, so
// that pair of assertions is the whole contract between them.
//
// It matters here because `buildWorkPayload` is deliberately tolerant: a field
// this builder cannot find becomes a default, so a renamed key would empty the
// board rather than throw. Reading a real stored row field-for-field is what
// turns that silent failure into a red test.
const STORED_BY_THE_ROUTE = {
  projects: [
    {
      asset: "root-os",
      prefix: "zz",
      ok: true,
      error: null,
      counts: { open: 3, highPriority: 2, ready: 2, inProgress: 1, blocked: 1, closedRecent: 1, deferred: 1, waiting: 0 },
      priorities: [1, 1, 2, 0, 0],
      epics: [
        {
          id: "zz-epc",
          title: "Make the board honest",
          status: "open",
          priority: 1,
          total: 9,
          closed: 4,
          counts: { open: 3, inProgress: 1, blocked: 1, deferred: 1 },
          priorities: [1, 1, 2, 0, 0],
        },
      ],
      ready: [
        {
          id: "zz-135",
          title: "Ready feature two",
          status: "open",
          priority: 0,
          issueType: "feature",
          assignee: "operator",
          updatedAt: "2026-08-01T16:30:53.000Z",
          closedAt: null,
          parent: "zz-epc",
          deferUntil: null,
        },
        {
          id: "zz-4qr",
          title: "Ready task one",
          status: "open",
          priority: 1,
          issueType: "task",
          assignee: null,
          updatedAt: "2026-08-01T16:30:52.000Z",
          closedAt: null,
          parent: "zz-epc",
          deferUntil: null,
        },
      ],
      inProgress: [
        {
          id: "zz-p6y",
          title: "Work in flight",
          status: "in_progress",
          priority: 2,
          issueType: "bug",
          assignee: "agent-x",
          updatedAt: "2026-08-01T16:30:58.000Z",
          closedAt: null,
          parent: "zz-epc",
          deferUntil: null,
        },
      ],
      deferred: [
        {
          id: "zz-hib",
          title: "Parked until the archive is deep enough",
          status: "deferred",
          priority: 2,
          issueType: "task",
          assignee: null,
          updatedAt: "2026-08-01T16:31:02.000Z",
          closedAt: null,
          parent: "zz-epc",
          deferUntil: "2026-08-29T00:00:00.000Z",
        },
      ],
      waiting: [
        {
          id: "zz-hum",
          title: "Decide whether the panel ships behind a flag",
          status: "open",
          priority: 1,
          issueType: "task",
          assignee: null,
          updatedAt: "2026-08-01T16:31:05.000Z",
          closedAt: null,
          parent: null,
          deferUntil: null,
        },
      ],
      recentlyClosed: [
        {
          id: "zz-0pb",
          title: "Finished item",
          status: "closed",
          priority: 2,
          issueType: "task",
          assignee: null,
          updatedAt: "2026-08-01T16:30:59.000Z",
          closedAt: "2026-08-01T16:30:59.000Z",
          parent: "zz-epc",
          deferUntil: null,
        },
      ],
    },
    {
      asset: "nosh.example",
      prefix: "nom",
      ok: false,
      error:
        'bd active exited 1: Error: cannot use -C directory "/Users/operator/dev/does-not-exist": stat /Users/operator/dev/does-not-exist: no such file or directory',
      counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
      priorities: [0, 0, 0, 0, 0],
      ready: [],
      inProgress: [],
      recentlyClosed: [],
    },
  ],
};

describe("buildWorkPayload over a real stored row", () => {
  it("reads every field the ingest route actually writes", async () => {
    await seedPayload("2026-08-01T16:53:14.126Z", STORED_BY_THE_ROUTE);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.capturedAt).toBe("2026-08-01T16:53:14.126Z");
    expect(payload.projects).toHaveLength(2);

    const [os, nom] = payload.projects;
    // Nothing silently defaulted: every field arrives with its real value.
    expect(os).toEqual({
      asset: "root-os",
      prefix: "zz",
      name: "NoticeOS",
      ok: true,
      error: null,
      counts: { open: 3, highPriority: 2, ready: 2, inProgress: 1, blocked: 1, closedRecent: 1, deferred: 1, waiting: 0 },
      // The rollup holds nothing, so every series is empty — a store that HAS
      // the daily history and no days in it yet, as a new installation's has.
      history: emptyWorkHistory(),
      priorities: [1, 1, 2, 0, 0],
      epics: STORED_BY_THE_ROUTE.projects[0]!.epics,
      ready: STORED_BY_THE_ROUTE.projects[0]!.ready,
      inProgress: STORED_BY_THE_ROUTE.projects[0]!.inProgress,
      recentlyClosed: STORED_BY_THE_ROUTE.projects[0]!.recentlyClosed,
      deferred: STORED_BY_THE_ROUTE.projects[0]!.deferred,
      waiting: STORED_BY_THE_ROUTE.projects[0]!.waiting,
    });
    expect(nom).toMatchObject({ asset: "nosh.example", name: "nosh.example", ok: false,
    });
    expect(nom!.error).toMatch(/no such file or directory/);
  });

  // The snapshot carries two fields this board deliberately does not: the
  // asset card's panel-review state, and the finding cards' handoff join
  // (beads `ro-rkp`, `ro-248`). Both name beads this board already lists as
  // ordinary work under their own project, so letting the spread carry them
  // would put undeclared fields in a payload no reader here consumes.
  it("drops the card-only fields instead of spreading them into the board", async () => {
    await seed("2026-08-01T11:59:00.000Z", [
      {
        ...project(),
        panelReview: {
          beadId: "mp-pnl",
          panelDate: "2026-07-28",
          dueAt: "2026-08-04T00:00:00.000Z",
          status: "open",
          closedAt: null,
        },
        handoffs: [
          { kind: "finding", key: "gsc-decline-1", beadId: "mp-1w2", status: "open", closedAt: null,
        },
        ],
      },
    ]);

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.projects[0]).not.toHaveProperty("panelReview");
    expect(payload.projects[0]).not.toHaveProperty("handoffs");
    // …and the board still renders everything it does own.
    expect(payload.projects[0]!.ready.map((i) => i.id)).toEqual(["mp-1w2", "mp-88x"]);
  });
});

describe("the work vocabulary", () => {
  it("names only the priorities that are not the default", () => {
    // A board where every row says "normal" hides the ones that are not.
    expect(priorityLabel(0)).toBe("top");
    expect(priorityLabel(1)).toBe("high");
    expect(priorityLabel(2)).toBeNull();
    expect(priorityLabel(3)).toBe("low");
    expect(priorityLabel(4)).toBe("lowest");
  });

  it("treats a project with nothing in any lane as having no work", () => {
    const idle = {
      asset: "a",
      prefix: "a",
      name: "A",
      ok: true,
      error: null,
      counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0,
      },
      history: emptyWorkHistory(),
      priorities: [0, 0, 0, 0, 0],
      epics: null,
      ready: [],
      inProgress: [],
      recentlyClosed: [],
      deferred: [],
      waiting: [],
    };
    expect(hasWork(idle)).toBe(false);
    expect(hasWork({ ...idle, counts: { ...idle.counts, blocked: 1 } })).toBe(true);
    expect(hasWork({ ...idle, counts: { ...idle.counts, closedRecent: 3 } })).toBe(true);
  });

  it("ages the board against the runner's own poll cadence", () => {
    // One minute — so a dead poller turns the header chip amber in two, rather
    // than showing yesterday's work as current.
    expect(WORK_POLL_CADENCE_HOURS * 60).toBeCloseTo(1, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The daily rollup behind the Tasks strip (db/0032, bead `ro-78qo.23`)
// ─────────────────────────────────────────────────────────────────────────────

/** One rollup row, written the way the ingest worker writes it, in this
 * test's own Postgres copy. */
async function seedDay(
  asset: string,
  day: string,
  counts: {
    waiting?: number | null;
    urgent?: number | null;
    open: number;
    inProgress: number;
    blocked: number;
    closed?: string[] | null;
  },
): Promise<void> {
  await (store.call).write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.task_daily_counts
         (workspace_id, project, day, captured_at, waiting, urgent, open, in_progress, blocked, closed_ids)
       VALUES ($1::uuid, $2, $3::date, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        tx.workspaceId,
        asset,
        day,
        `${day}T23:59:00.000Z`,
        counts.waiting ?? null,
        counts.urgent ?? null,
        counts.open,
        counts.inProgress,
        counts.blocked,
        counts.closed === null || counts.closed === undefined ? null : JSON.stringify(counts.closed),
      ],
    ),
  );
}

describe("the daily history the strip's six numbers ride", () => {
  it("carries a point per day beside every count", async () => {
    await seed("2026-08-01T11:59:00.000Z", [project()]);
    await seedDay("meals.example", "2026-07-30", {
      waiting: 1,
      urgent: 2,
      open: 5,
      inProgress: 1,
      blocked: 0,
      closed: ["mp-a", "mp-b"],
    });
    await seedDay("meals.example", "2026-07-31", {
      waiting: 0,
      urgent: 1,
      open: 4,
      inProgress: 2,
      blocked: 1,
      closed: ["mp-c"],
    });

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.historyDays).toBe(2);
    expect(payload.projects[0]!.history.open).toEqual([
      { t: "2026-07-30", v: 5 },
      { t: "2026-07-31", v: 4 },
    ]);
    // The closed series counts the day's CLOSINGS — the size of the set of ids,
    // never the seven-day total the headline carries.
    expect(payload.projects[0]!.history.closed).toEqual([
      { t: "2026-07-30", v: 2 },
      { t: "2026-07-31", v: 1 },
    ]);
    expect(payload.projects[0]!.history.blocked).toEqual([
      { t: "2026-07-30", v: 0 },
      { t: "2026-07-31", v: 1 },
    ]);
  });

  it("leaves an unmeasured count out of ITS series and no other", async () => {
    await seed("2026-08-01T11:59:00.000Z", [project()]);
    // A day an older poller measured neither the inbox nor urgency, and whose
    // closings were never observable.
    await seedDay("meals.example", "2026-07-30", {
      waiting: null,
      urgent: null,
      open: 5,
      inProgress: 1,
      blocked: 0,
      closed: null,
    });
    await seedDay("meals.example", "2026-07-31", {
      waiting: 3,
      urgent: 1,
      open: 4,
      inProgress: 1,
      blocked: 0,
      closed: [],
    });

    const history = (await buildWorkPayload(store.call, { now: NOW })).projects[0]!.history;

    // The gap is in the three series that were not measured…
    expect(history.waiting).toEqual([{ t: "2026-07-31", v: 3 }]);
    expect(history.urgent).toEqual([{ t: "2026-07-31", v: 1 }]);
    expect(history.closed).toEqual([{ t: "2026-07-31", v: 0 }]);
    // …and never a zero, and never in the ones that were.
    expect(history.open).toHaveLength(2);
  });

  it("gives a project the rollup has never seen an empty history rather than dropping it", async () => {
    await seed("2026-08-01T11:59:00.000Z", [project(), project({ asset: "nosh.example", prefix: "nom" })]);
    await seedDay("meals.example", "2026-07-31", { open: 4, inProgress: 1, blocked: 0 });

    const payload = await buildWorkPayload(store.call, { now: NOW });

    expect(payload.projects.map((one) => one.asset)).toEqual(["meals.example", "nosh.example"]);
    expect(payload.projects[1]!.history.open).toEqual([]);
  });

  it("answers a first-run board with no snapshot at all", async () => {
    const payload = await buildWorkPayload(store.call, { now: NOW });
    expect(payload.projects).toEqual([]);
    expect(payload.historyDays).toBe(0);
  });
});

describe("summing the daily history across the projects on a board", () => {
  const points = (days: string[], value: number) => days.map((t) => ({ t, v: value }));

  function withHistory(asset: string, history: Partial<WorkCountsHistory>): WorkProject {
    return {
      asset,
      prefix: asset.slice(0, 2),
      name: asset,
      ok: true,
      error: null,
      counts: {
        open: 0,
        highPriority: 0,
        ready: 0,
        inProgress: 0,
        blocked: 0,
        closedRecent: 0,
        deferred: 0,
        waiting: 0,
      },
      history: { ...emptyWorkHistory(), ...history },
      priorities: null,
      epics: null,
      ready: [],
      inProgress: [],
      recentlyClosed: [],
      deferred: [],
      waiting: [],
    };
  }

  it("adds the projects up, day by day", () => {
    const summed = sumWorkHistory([
      withHistory("a", { open: points(["2026-07-30", "2026-07-31"], 2) }),
      withHistory("b", { open: points(["2026-07-30", "2026-07-31"], 3) }),
    ]);
    expect(summed.open).toEqual([
      { t: "2026-07-30", v: 5 },
      { t: "2026-07-31", v: 5 },
    ]);
  });

  it("drops a day one of the projects did not measure", () => {
    // Otherwise the portfolio would appear to shrink on the day a project went
    // quiet, which is a shape nothing observed.
    const summed = sumWorkHistory([
      withHistory("a", { open: points(["2026-07-30", "2026-07-31"], 2) }),
      withHistory("b", { open: points(["2026-07-31"], 3) }),
    ]);
    expect(summed.open).toEqual([{ t: "2026-07-31", v: 5 }]);
  });

  it("answers nothing for a board with no projects on it", () => {
    expect(sumWorkHistory([])).toEqual(emptyWorkHistory());
  });

  it("degrades a payload carrying no history at all to no series", () => {
    // A Worker one generation behind the client rendering it. A blank sparkline
    // is a better answer than a blank page.
    const older = { ...withHistory("a", {}), history: undefined } as unknown as WorkProject;
    expect(sumWorkHistory([older])).toEqual(emptyWorkHistory());
  });
});
