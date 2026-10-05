import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TASK_SOURCES,
  TASK_SOURCES_PATH,
  connectedTaskSource,
  taskSourceConnection,
  type TaskSourceStatus,
} from "../shared/task-source";
import { TASK_PROJECTS_PATH } from "../shared/tasks";
import {
  TASK_SOURCE_ADAPTERS,
  beadsConnected,
  beadsTaskSource,
  buildTaskBoard,
  buildTaskSourcePayload,
  readTaskSources,
} from "../worker/task-source";
import { buildWorkPayload } from "../worker/work-payload";
import { createTestStore, type TestStore } from "./postgres-store";
import { seedSnapshot, workCounts, workProject } from "./panel-fixtures";

// THE TASK SOURCE SEAM (decision D32, bead ro-ujb9.143). "Connected" is derived
// from the source's own reading, never stored; the beads hub is the first
// adapter and wraps the runner's snapshot unchanged. Example names only.

const CAPTURED = "2026-09-06T11:59:30.000Z";
const NOW = new Date("2026-09-06T12:00:00.000Z");
/** A connected installation's shape: two task projects, one gate and one ask
 * waiting on the operator on the first. */
function connectedProjects() {
  return [
    workProject({
      asset: "example.com",
      prefix: "ex",
      counts: workCounts({ waiting: 2 }),
      waitingUrgent: 1,
      waiting: [
        { id: "ex-g1", title: "Approve the launch", status: "open", priority: 2, issueType: "gate" },
        { id: "ex-h1", title: "Choose the headline", status: "open", priority: 3, issueType: "task" },
      ],
    }),
    workProject({ asset: "shop.example.com", prefix: "shop", counts: workCounts({ waiting: 0 }), waitingUrgent: 0 }),
  ];
}

let ctx: TestStore;
beforeEach(async () => { ctx = await createTestStore(); });
afterEach(() => ctx.close());

describe("when a task source is connected", () => {
  it("is not connected on a fresh install: no snapshot has ever been filed", async () => {
    expect(await buildTaskSourcePayload({ store: ctx.call, savedProjects: { beads: 0 } })).toEqual({
      connected: null,
      sources: [{ id: "beads", connected: false, projects: 0, readAt: null, failing: 0 }],
    });
  });

  it("is not connected while the runner reads no project — the empty snapshot a fresh install files", async () => {
    await seedSnapshot(ctx, CAPTURED, []);
    const payload = await buildTaskSourcePayload({ store: ctx.call, savedProjects: { beads: 0 } });
    expect(payload.connected).toBeNull();
    expect(beadsConnected({ capturedAt: CAPTURED, projects: [] })).toBe(false);
  });

  it("is being set up, not connected, when a project is saved and the runner has not read it yet", async () => {
    await seedSnapshot(ctx, CAPTURED, []);
    const payload = await buildTaskSourcePayload({ store: ctx.call, savedProjects: { beads: 1 } });
    expect(payload.connected).toBeNull();
    expect(taskSourceConnection(payload.sources[0]!, NOW.getTime())).toBe("collecting");
  });

  it("is connected once the runner's newest snapshot reads a task project", async () => {
    await seedSnapshot(ctx, CAPTURED, connectedProjects());
    expect(await buildTaskSourcePayload({ store: ctx.call, savedProjects: { beads: 2 } })).toEqual({
      connected: "beads",
      sources: [{ id: "beads", connected: true, projects: 2, readAt: CAPTURED, failing: 0 }],
    });
  });

  it("stays connected when a project cannot be read, so the failure shows where the tasks are", async () => {
    await seedSnapshot(ctx, CAPTURED, [workProject({ asset: "example.com", prefix: "ex", ok: false, error: "bd ready exited 1" })]);
    const payload = await buildTaskSourcePayload({ store: ctx.call, savedProjects: { beads: 1 } });
    expect(payload.connected).toBe("beads");
    expect(taskSourceConnection(payload.sources[0]!, NOW.getTime())).toBe("failing");
  });

  it("disconnects when the last project is removed: the runner files an empty snapshot over the old one", async () => {
    await seedSnapshot(ctx, "2026-09-06T11:58:30.000Z", connectedProjects());
    await seedSnapshot(ctx, CAPTURED, []);
    expect((await buildTaskSourcePayload({ store: ctx.call, savedProjects: { beads: 0 } })).connected).toBeNull();
  });
});

describe("the beads adapter wraps today's snapshot unchanged", () => {
  it("answers the board, Needs you and a site's inbox from one reading", async () => {
    await seedSnapshot(ctx, CAPTURED, connectedProjects());
    const reading = await beadsTaskSource.read({ store: ctx.call });
    expect(reading.status.connected).toBe(true);
    // The board is exactly what `/api/work` built before the seam existed.
    expect(await reading.board(NOW)).toEqual(await buildWorkPayload(ctx.call, { now: NOW }));
    expect(reading.needsYou()).toEqual({
      waiting: 2, urgent: 1, measuredProjects: 2, urgentMeasuredProjects: 2, projectCount: 2, capturedAt: CAPTURED,
    });
    expect(reading.inbox("example.com")).toMatchObject({ capturedAt: CAPTURED, waiting: 2, urgent: 1 });
    expect(reading.inbox("example.com").items.map((item) => item.id)).toEqual(["ex-g1", "ex-h1"]);
    // A site with no task project is still "not measured", exactly as before.
    expect(reading.inbox("other.example.com")).toEqual({ capturedAt: CAPTURED, waiting: null, urgent: null, items: [] });
  });

  it("gives an installation with no task source an empty board, whatever an older snapshot holds", async () => {
    await seedSnapshot(ctx, "2026-09-06T11:58:30.000Z", connectedProjects());
    await seedSnapshot(ctx, CAPTURED, []);
    const board = await buildTaskBoard({ store: ctx.call }, NOW);
    expect(board.projects).toEqual([]);
    expect(board.capturedAt).toBe(CAPTURED);
  });

  it("serves a connected installation's board unchanged", async () => {
    await seedSnapshot(ctx, CAPTURED, connectedProjects());
    expect(await buildTaskBoard({ store: ctx.call }, NOW)).toEqual(await buildWorkPayload(ctx.call, { now: NOW }));
  });

  it("is the registry's one adapter, and the connected source is the first one connected", async () => {
    expect(Object.keys(TASK_SOURCE_ADAPTERS)).toEqual(["beads"]);
    await seedSnapshot(ctx, CAPTURED, connectedProjects());
    const { readings, connected } = await readTaskSources({ store: ctx.call });
    expect(readings.map((reading) => reading.status.id)).toEqual(["beads"]);
    expect(connected?.status.id).toBe("beads");
  });
});

describe("the core task hub reading", () => {
  const status = (overrides: Partial<TaskSourceStatus>): TaskSourceStatus => ({
    id: "beads", connected: true, projects: 2, readAt: CAPTURED, failing: 0, ...overrides,
  });
  const now = NOW.getTime();

  it("wears the connection vocabulary's one word", () => {
    expect(taskSourceConnection(status({ connected: false, projects: 0, readAt: null }), now)).toBe("not-connected");
    expect(taskSourceConnection(status({ connected: false, projects: 1, readAt: null }), now)).toBe("collecting");
    expect(taskSourceConnection(status({}), now)).toBe("working");
    expect(taskSourceConnection(status({ failing: 1 }), now)).toBe("working");
    expect(taskSourceConnection(status({ failing: 2 }), now)).toBe("failing");
    // Twice the runner's one-minute cadence, and the read is overdue.
    expect(taskSourceConnection(status({ readAt: "2026-09-06T11:57:00.000Z" }), now)).toBe("overdue");
  });

  it("keeps core project management on the existing Settings surface", () => {
    expect(TASK_SOURCES.beads).toEqual({ name: "Beads", setupPath: TASK_PROJECTS_PATH });
    expect(TASK_SOURCES_PATH).toBe(TASK_PROJECTS_PATH);
  });
});

describe("reading a /api/task-source reply", () => {
  it("reads the actual connection without controlling core navigation", () => {
    expect(connectedTaskSource({ connected: null, sources: [] })).toBeNull();
    expect(connectedTaskSource({ connected: "beads", sources: [] })).toBe("beads");
  });

  it("does not invent a connection from a reply it cannot read", () => {
    expect(connectedTaskSource(undefined)).toBeNull();
    expect(connectedTaskSource({})).toBeNull();
    expect(connectedTaskSource({ connected: "something-else" })).toBeNull();
  });
});
