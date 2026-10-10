import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BEADS_MAX_ITEMS,
  BEADS_MAX_PROJECTS,
  BEADS_SNAPSHOT_RETENTION_DAYS,
  WALL_FEED_REACH_HOURS,
  droppedHandoffEvent,
  supersededPayload,
  writeBeadsSnapshot,
} from '../src/beads-snapshots.js';
import { readSnapshotProjects } from '../src/beads-daily.js';
import { javascriptInstant } from '@noticeos/postgres';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call, reset, storedCount } from './helpers.js';

beforeEach(reset);

interface SnapshotBody {
  created: boolean;
  capturedAt: string;
  projects: number;
  pruned: number;
}

interface ValidationBody {
  error: string;
  issues: { path: string; code: string; message: string }[];
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mp-1w2',
    title: 'Fix the recipe schema',
    status: 'open',
    priority: 1,
    issueType: 'task',
    assignee: null,
    updatedAt: '2026-08-01T09:00:00.000Z',
    closedAt: null,
    parent: 'zz-epc',
    deferUntil: null,
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    asset: 'meals.example',
    prefix: 'mp',
    ok: true,
    error: null,
    counts: { open: 2, highPriority: 1, ready: 1, inProgress: 1, blocked: 0, closedRecent: 0 },
    priorities: [0, 1, 2, 0, 0],
    ready: [issue()],
    inProgress: [issue({ id: 'mp-33j', status: 'in_progress', assignee: 'agent-x' })],
    recentlyClosed: [],
    ...overrides,
  };
}

function snapshotRequest(body: unknown, opts: { token?: string; raw?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request('https://ingest.local/api/beads-snapshot', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

async function post(body: unknown, token: string | undefined = OPERATOR_TOKEN) {
  return call(snapshotRequest(body, { token }));
}

// Two consecutive poller ticks, dated off the real clock rather than written
// down as literals: the insert path prunes anything older than
// BEADS_SNAPSHOT_RETENTION_DAYS, so a hardcoded date fixture stops meaning what
// it says once the window slides past it. Kept an hour back and a minute apart.
const FIRST_TICK = new Date(Date.now() - 3_600_000).toISOString();
const SECOND_TICK = new Date(Date.parse(FIRST_TICK) + 60_000).toISOString();

/** Insert a snapshot directly, to age it past what a request could claim. */
async function seedSnapshot(capturedAt: string): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload) VALUES ($1::uuid, $2::timestamptz, $3::jsonb)`,
      [tx.workspaceId, capturedAt, JSON.stringify({ projects: [] })],
    ),
  );
}

/** How many photographs the store holds. */
async function snapshots(): Promise<number> {
  return storedCount('SELECT count(*)::int AS n FROM noticeos.task_snapshots');
}

/** The stored photographs, newest first as the Tower reads them: when each was
 * taken, as JavaScript writes an instant, and its payload as JSON text. */
async function storedRows(): Promise<{ captured_at: string; payload: string }[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ captured_at: string; payload: string }>(
      `SELECT captured_at, payload::text AS payload FROM noticeos.task_snapshots ORDER BY captured_at DESC, snapshot_id DESC`,
    ),
  );
  return rows.map((row) => ({ ...row, captured_at: javascriptInstant(row.captured_at) }));
}

describe('POST /api/beads-snapshot — auth', () => {
  it('rejects a request without the operator token (401)', async () => {
    const res = await call(snapshotRequest({ projects: [] }));
    expect(res.status).toBe(401);
    expect(await snapshots()).toBe(0);
  });

  it('rejects a wrong operator token (401)', async () => {
    const res = await post({ projects: [] }, 'nope');
    expect(res.status).toBe(401);
    expect(await snapshots()).toBe(0);
  });
});

describe('POST /api/beads-snapshot — writes', () => {
  it('stores a snapshot and reports what it filed (201)', async () => {
    const res = await post({ capturedAt: FIRST_TICK, projects: [project()] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SnapshotBody;
    expect(body).toMatchObject({
      created: true,
      capturedAt: FIRST_TICK,
      projects: 1,
      pruned: 0,
    });
    expect(await snapshots()).toBe(1);
  });

  it('an unchanged board touches the latest row instead of duplicating it', async () => {
    // A quiet hub files byte-identical boards once a minute. The store keeps
    // one row per distinct board state and moves captured_at forward, so the
    // Tower's freshness read and the retention prune both stay honest while a
    // week of quiet costs one row.
    await post({ capturedAt: FIRST_TICK, projects: [project()] });
    const second = await post({ capturedAt: SECOND_TICK, projects: [project()] });
    expect(second.status).toBe(201); // the poller treats non-201 as failure
    const secondBody = (await second.json()) as SnapshotBody & { unchanged: boolean };
    expect(secondBody).toMatchObject({
      created: false,
      unchanged: true,
      capturedAt: SECOND_TICK,
    });
    // The store's own identity never leaves it.
    expect(secondBody).not.toHaveProperty('id');
    expect(await snapshots()).toBe(1);
    expect((await storedRows())[0]!.captured_at).toBe(SECOND_TICK);
  });

  it('a changed board still inserts its own row', async () => {
    await post({ capturedAt: FIRST_TICK, projects: [project()] });
    const changed = project({
      counts: { open: 3, highPriority: 1, ready: 1, inProgress: 1, blocked: 0, closedRecent: 0 },
    });
    const res = await post({ capturedAt: SECOND_TICK, projects: [changed] });
    const body = (await res.json()) as SnapshotBody & { unchanged: boolean };
    expect(body).toMatchObject({ created: true, unchanged: false });
    expect(await snapshots()).toBe(2);
  });

  it('stores the payload as the normalized JSON the Tower reads', async () => {
    await post({ capturedAt: FIRST_TICK, projects: [project()] });
    const [row] = await storedRows();
    const stored = JSON.parse(row!.payload) as { projects: Record<string, unknown>[] };
    expect(stored.projects).toHaveLength(1);
    expect(stored.projects[0]).toMatchObject({
      asset: 'meals.example',
      prefix: 'mp',
      ok: true,
      counts: { open: 2, highPriority: 1, ready: 1, inProgress: 1, blocked: 0, closedRecent: 0 },
    });
    expect(stored.projects[0]!.ready).toHaveLength(1);
  });

  // Two snapshots a second apart are two observations of a changing hub, not
  // the same event twice — so unlike the annotation lane there is no idempotent
  // re-post collapsing them; identical boards touch instead (the two tests above).

  it('defaults capturedAt to now when it is omitted', async () => {
    const before = Date.now();
    const res = await post({ projects: [] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SnapshotBody;
    const at = Date.parse(body.capturedAt);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // An unreadable repo is the whole point of per-project isolation: the other
  // projects still file, and the failure is recorded rather than dropped.
  it('accepts a project that reports an error and carries no work', async () => {
    const res = await post({
      projects: [
        project(),
        project({
          asset: 'nosh.example',
          prefix: 'nom',
          ok: false,
          error: 'bd ready exited 1: no beads project found',
          counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0 },
          ready: [],
          inProgress: [],
      recentlyClosed: [],
        }),
      ],
    });
    expect(res.status).toBe(201);
    const [row] = await storedRows();
    const stored = JSON.parse(row!.payload) as {
      projects: { asset: string; ok: boolean; error: string | null }[];
    };
    expect(stored.projects.map((p) => [p.asset, p.ok])).toEqual([
      ['meals.example', true],
      ['nosh.example', false],
    ]);
    expect(stored.projects[1]!.error).toMatch(/no beads project found/);
  });

  // The asset id is NOT checked against `assets`. A project that drifted out of
  // config/beads.json should surface on the board as an unrecognized name, not
  // cost the other five their snapshot.
  it('stores a project whose asset the store has never heard of', async () => {
    const res = await post({ projects: [project({ asset: 'ghost.site', prefix: 'gh' })] });
    expect(res.status).toBe(201);
    expect(await snapshots()).toBe(1);
  });

  // One-generation skew: the Worker hot-reloads the moment a file is saved,
  // while the poller — a plain node process — keeps sending the old shape until
  // the operator restarts it. A validator that rejects what its own producer is
  // currently sending is the outage.
  it('accepts a poller one generation behind, with no highPriority at all', async () => {
    const res = await post({
      projects: [
        project({ counts: { open: 2, ready: 1, inProgress: 1, blocked: 0, closedRecent: 0 } }),
      ],
    });
    expect(res.status).toBe(201);

    const [row] = await storedRows();
    const stored = JSON.parse(row!.payload) as {
      projects: { counts: Record<string, number> }[];
    };
    // Absent stays ABSENT. A 0 here would be a measurement nobody took, and it
    // renders on a property card as "nothing is urgent" — so the key is gone,
    // not zeroed, and a reader can tell the two apart.
    expect(stored.projects[0]!.counts).toEqual({
      open: 2,
      ready: 1,
      inProgress: 1,
      blocked: 0,
      closedRecent: 0,
    });
    expect('highPriority' in stored.projects[0]!.counts).toBe(false);
  });

  it('accepts a poller that sends no queue shape at all', async () => {
    const { priorities: _older, ...noShape } = project();
    const res = await post({ projects: [noShape] });
    expect(res.status).toBe(201);
    const [row] = await storedRows();
    const stored = JSON.parse(row!.payload) as { projects: Record<string, unknown>[] };
    expect('priorities' in stored.projects[0]!).toBe(false);
  });

  // A short, long, or non-numeric array is a producer BUG, not skew — padding
  // it would hand the card a distribution with the wrong mass, which draws a
  // confident bar about a queue nobody measured.
  it('rejects a queue shape that is not exactly five bands (422)', async () => {
    const short = await post({ projects: [project({ priorities: [1, 2, 3] })] });
    expect(short.status).toBe(422);
    expect(((await short.json()) as ValidationBody).issues[0]).toMatchObject({
      path: 'projects.0.priorities',
      code: 'invalid_format',
    });

    const wrongType = await post({
      projects: [project({ priorities: [1, 2, 'three', 4, 5] })],
    });
    expect(wrongType.status).toBe(422);
    expect(((await wrongType.json()) as ValidationBody).issues[0]).toMatchObject({
      path: 'projects.0.priorities.2',
      code: 'invalid_type',
    });

    expect(await snapshots()).toBe(0);
  });

  it('stores an explicit null highPriority as absent rather than as zero', async () => {
    await post({
      projects: [
        project({
          counts: { open: 2, highPriority: null, ready: 1, inProgress: 1, blocked: 0, closedRecent: 0 },
        }),
      ],
    });
    const [row] = await storedRows();
    const stored = JSON.parse(row!.payload) as {
      projects: { counts: Record<string, number> }[];
    };
    expect('highPriority' in stored.projects[0]!.counts).toBe(false);
  });

  // `bd` ships seven statuses and lets an operator add custom ones. Pinning the
  // enum here would turn a `bd config` change into a 422 on a lane that is only
  // writing down what it saw.
  it('stores a status the OS has never seen', async () => {
    const res = await post({
      projects: [project({ ready: [issue({ status: 'awaiting-review' })] })],
    });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/beads-snapshot — validation', () => {
  it('rejects an unparseable body (400)', async () => {
    const res = await call(
      snapshotRequest(null, { token: OPERATOR_TOKEN, raw: 'not json' }),
    );
    expect(res.status).toBe(400);
    expect(await snapshots()).toBe(0);
  });

  it('rejects a non-object body (400)', async () => {
    const res = await post([project()]);
    expect(res.status).toBe(400);
  });

  it('rejects a missing projects array (422)', async () => {
    const res = await post({ capturedAt: FIRST_TICK });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.error).toBe('validation');
    expect(body.issues[0]).toMatchObject({ path: 'projects', code: 'invalid_type' });
  });

  // A future snapshot would sit at the top of the board forever and make a dead
  // poller look fresh.
  it('rejects a post-dated capturedAt (422)', async () => {
    const res = await post({
      capturedAt: new Date(Date.now() + 3_600_000).toISOString(),
      projects: [],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]).toMatchObject({ path: 'capturedAt', code: 'custom' });
    expect(await snapshots()).toBe(0);
  });

  it('rejects a fractional or negative count (422)', async () => {
    const res = await post({
      projects: [project({ counts: { open: 1.5, highPriority: 0, ready: -1, inProgress: 0, blocked: 0, closedRecent: 0 } })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['projects.0.counts.open', 'projects.0.counts.ready']),
    );
  });

  // A count that IS sent must still be valid — tolerating skew is not
  // tolerating corruption.
  it('rejects a highPriority that is present and not a whole number (422)', async () => {
    const res = await post({
      projects: [
        project({
          counts: { open: 2, highPriority: 'lots', ready: 1, inProgress: 1, blocked: 0, closedRecent: 0 },
        }),
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]).toMatchObject({
      path: 'projects.0.counts.highPriority',
      code: 'invalid_type',
    });
    expect(await snapshots()).toBe(0);
  });

  it('rejects an urgent human subset larger than the whole human inbox', async () => {
    const res = await post({
      projects: [
        project({
          counts: {
            open: 2,
            highPriority: 1,
            ready: 1,
            inProgress: 1,
            blocked: 0,
            closedRecent: 0,
            waiting: 1,
          },
          waitingUrgent: 2,
        }),
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]).toMatchObject({
      path: 'projects.0.waitingUrgent',
      code: 'custom',
    });
  });

  it('reports every problem in one response, not just the first', async () => {
    const res = await post({
      projects: [project({ ready: [issue({ id: '', title: '', priority: 'high' })] })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        'projects.0.ready.0.id',
        'projects.0.ready.0.title',
        'projects.0.ready.0.priority',
      ]),
    );
  });

  // A half-read repo that still claims work is how a failure would quietly look
  // healthy on the board.
  it('rejects a failed project that still carries issues (422)', async () => {
    const res = await post({
      projects: [project({ ok: false, error: 'bd exploded' })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]).toMatchObject({ path: 'projects.0.ok', code: 'custom' });
  });

  it('rejects a failed project with no reason (422)', async () => {
    const res = await post({
      projects: [
        project({
          ok: false,
          error: null,
          counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0 },
          ready: [],
          inProgress: [],
          recentlyClosed: [],
        }),
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]).toMatchObject({ path: 'projects.0.error', code: 'custom' });
  });

  it('bounds how much one snapshot may carry (422)', async () => {
    const tooManyItems = Array.from({ length: BEADS_MAX_ITEMS + 1 }, (_, i) =>
      issue({ id: `mp-${i}` }),
    );
    const res = await post({ projects: [project({ ready: tooManyItems })] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]).toMatchObject({ path: 'projects.0.ready', code: 'too_big' });

    const tooManyProjects = Array.from({ length: BEADS_MAX_PROJECTS + 1 }, (_, i) =>
      project({ asset: `a${i}.example`, prefix: `p${i}` }),
    );
    const second = await post({ projects: tooManyProjects });
    expect(second.status).toBe(422);
    expect(((await second.json()) as ValidationBody).issues[0]).toMatchObject({
      path: 'projects',
      code: 'too_big',
    });
  });
});

// Recorded verbatim from the poller in `scripts/os-up.mjs` running against a
// real Dolt hub: one populated project and one whose repo was missing. The
// producer and this route are in different packages and cannot import each
// other, so this fixture is the seam.
const RECORDED_POLLER_BODY = {
  capturedAt: '2026-08-01T16:53:14.126Z',
  projects: [
    {
      asset: 'root-os',
      prefix: 'zz',
      ok: true,
      error: null,
      counts: { open: 3, highPriority: 2, ready: 2, inProgress: 1, blocked: 1, closedRecent: 1, deferred: 1, waiting: 1 },
      waitingUrgent: 1,
      priorities: [1, 1, 2, 0, 0],
      epics: [
        {
          id: 'zz-epc',
          title: 'Make the board honest',
          status: 'open',
          priority: 1,
          total: 9,
          closed: 4,
          counts: { open: 3, inProgress: 1, blocked: 1, deferred: 1 },
          priorities: [1, 1, 2, 0, 0],
        },
      ],
      ready: [
        {
          id: 'zz-135',
          title: 'Ready feature two',
          status: 'open',
          priority: 0,
          issueType: 'feature',
          assignee: 'operator',
          updatedAt: '2026-08-01T16:30:53.000Z',
          closedAt: null,
          parent: 'zz-epc',
          deferUntil: null,
        },
        {
          id: 'zz-4qr',
          title: 'Ready task one',
          status: 'open',
          priority: 1,
          issueType: 'task',
          assignee: null,
          updatedAt: '2026-08-01T16:30:52.000Z',
          closedAt: null,
          parent: 'zz-epc',
          deferUntil: null,
        },
      ],
      inProgress: [
        {
          id: 'zz-p6y',
          title: 'Work in flight',
          status: 'in_progress',
          priority: 2,
          issueType: 'bug',
          assignee: 'agent-x',
          updatedAt: '2026-08-01T16:30:58.000Z',
          closedAt: null,
          parent: 'zz-epc',
          deferUntil: null,
        },
      ],
      deferred: [
        {
          id: 'zz-hib',
          title: 'Parked until the archive is deep enough',
          status: 'deferred',
          priority: 2,
          issueType: 'task',
          assignee: null,
          updatedAt: '2026-08-01T16:31:02.000Z',
          closedAt: null,
          parent: 'zz-epc',
          deferUntil: '2026-08-29T00:00:00.000Z',
        },
      ],
      waiting: [
        {
          id: 'zz-hum',
          title: 'Decide whether the panel ships behind a flag',
          status: 'open',
          priority: 1,
          issueType: 'task',
          assignee: null,
          updatedAt: '2026-08-01T16:31:05.000Z',
          closedAt: null,
          parent: null,
          deferUntil: null,
        },
      ],
      recentlyClosed: [
        {
          id: 'zz-0pb',
          title: 'Finished item',
          status: 'closed',
          priority: 2,
          issueType: 'task',
          assignee: null,
          updatedAt: '2026-08-01T16:30:59.000Z',
          closedAt: '2026-08-01T16:30:59.000Z',
          parent: 'zz-epc',
          deferUntil: null,
        },
      ],
    },
    {
      asset: 'nosh.example',
      prefix: 'nom',
      ok: false,
      error:
        'bd active exited 1: Error: cannot use -C directory "/Users/operator/dev/does-not-exist": stat /Users/operator/dev/does-not-exist: no such file or directory',
      counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
      priorities: [0, 0, 0, 0, 0],
      epics: [],
      ready: [],
      inProgress: [],
      recentlyClosed: [],
    },
  ],
};

describe('POST /api/beads-snapshot — the poller contract', () => {
  it('accepts what the runner actually sends', async () => {
    const res = await post(RECORDED_POLLER_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as SnapshotBody;
    expect(body).toMatchObject({ created: true, projects: 2 });

    const [row] = await storedRows();
    const stored = JSON.parse(row!.payload) as {
      projects: { asset: string; ok: boolean; ready: unknown[] }[];
    };
    // Nothing is lost or reordered on the way through.
    expect(stored.projects.map((p) => p.asset)).toEqual(['root-os', 'nosh.example']);
    expect(stored.projects[0]!.ready).toHaveLength(2);
    expect(stored.projects[1]!.ok).toBe(false);
  });

  // The third seam. `apps/tower/test/work-payload.test.ts` seeds a row and
  // renders it; that test cannot import this package, so this assertion is the
  // only thing pinning the two halves together. The literal below is duplicated
  // verbatim in that file — if this normalizer ever changes shape, THIS test
  // fails loudly instead of the board silently reading defaults for every
  // renamed field (the payload builder is deliberately tolerant, so drift there
  // is an empty board, not an exception).
  it('normalizes to exactly the payload the Tower reads', async () => {
    await post(RECORDED_POLLER_BODY);
    const [row] = await storedRows();

    expect(JSON.parse(row!.payload)).toEqual({
      projects: [
        {
          asset: 'root-os',
          prefix: 'zz',
          ok: true,
          error: null,
          counts: { open: 3, highPriority: 2, ready: 2, inProgress: 1, blocked: 1, closedRecent: 1, deferred: 1, waiting: 1 },
          waitingUrgent: 1,
          priorities: [1, 1, 2, 0, 0],
          epics: [
            {
              id: 'zz-epc',
              title: 'Make the board honest',
              status: 'open',
              priority: 1,
              total: 9,
              closed: 4,
              counts: { open: 3, inProgress: 1, blocked: 1, deferred: 1 },
              priorities: [1, 1, 2, 0, 0],
            },
          ],
          ready: [
            {
              id: 'zz-135',
              title: 'Ready feature two',
              status: 'open',
              priority: 0,
              issueType: 'feature',
              assignee: 'operator',
              updatedAt: '2026-08-01T16:30:53.000Z',
              closedAt: null,
              parent: 'zz-epc',
              deferUntil: null,
            },
            {
              id: 'zz-4qr',
              title: 'Ready task one',
              status: 'open',
              priority: 1,
              issueType: 'task',
              assignee: null,
              updatedAt: '2026-08-01T16:30:52.000Z',
              closedAt: null,
              parent: 'zz-epc',
              deferUntil: null,
            },
          ],
          inProgress: [
            {
              id: 'zz-p6y',
              title: 'Work in flight',
              status: 'in_progress',
              priority: 2,
              issueType: 'bug',
              assignee: 'agent-x',
              updatedAt: '2026-08-01T16:30:58.000Z',
              closedAt: null,
              parent: 'zz-epc',
              deferUntil: null,
            },
          ],
          deferred: [
            {
              id: 'zz-hib',
              title: 'Parked until the archive is deep enough',
              status: 'deferred',
              priority: 2,
              issueType: 'task',
              assignee: null,
              updatedAt: '2026-08-01T16:31:02.000Z',
              closedAt: null,
              parent: 'zz-epc',
              deferUntil: '2026-08-29T00:00:00.000Z',
            },
          ],
          waiting: [
            {
              id: 'zz-hum',
              title: 'Decide whether the panel ships behind a flag',
              status: 'open',
              priority: 1,
              issueType: 'task',
              assignee: null,
              updatedAt: '2026-08-01T16:31:05.000Z',
              closedAt: null,
              parent: null,
              deferUntil: null,
            },
          ],
          recentlyClosed: [
            {
              id: 'zz-0pb',
              title: 'Finished item',
              status: 'closed',
              priority: 2,
              issueType: 'task',
              assignee: null,
              updatedAt: '2026-08-01T16:30:59.000Z',
              closedAt: '2026-08-01T16:30:59.000Z',
              parent: 'zz-epc',
              deferUntil: null,
            },
          ],
        },
        {
          asset: 'nosh.example',
          prefix: 'nom',
          ok: false,
          error:
            'bd active exited 1: Error: cannot use -C directory "/Users/operator/dev/does-not-exist": stat /Users/operator/dev/does-not-exist: no such file or directory',
          counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
          priorities: [0, 0, 0, 0, 0],
          epics: [],
          ready: [],
          inProgress: [],
          recentlyClosed: [],
        },
      ],
    });
  });
});

// The SERP-panel triage state. Three-valued on the wire, and the two absences
// mean different things.
describe('POST /api/beads-snapshot — panel review', () => {
  const REVIEW = {
    beadId: 'nom-4q2',
    panelDate: '2026-08-02',
    dueAt: '2026-08-09T00:00:00.000Z',
    status: 'open',
    closedAt: null,
  };

  async function storedProject(body: unknown): Promise<Record<string, unknown>> {
    const res = await post(body);
    expect(res.status).toBe(201);
    const [row] = await storedRows();
    return (JSON.parse(row!.payload) as { projects: Record<string, unknown>[] }).projects[0]!;
  }

  it('stores the open review exactly as the Tower will read it', async () => {
    const stored = await storedProject({ projects: [project({ panelReview: REVIEW })] });
    expect(stored.panelReview).toEqual(REVIEW);
  });

  it('stores a closed review with the instant it was closed', async () => {
    const stored = await storedProject({
      projects: [
        project({
          panelReview: {
            beadId: 'nom-4q2',
            panelDate: '2026-08-02',
            dueAt: '2026-08-09T00:00:00.000Z',
            status: 'closed',
            closedAt: '2026-08-04T10:00:00.000Z',
          },
        }),
      ],
    });
    expect(stored.panelReview).toMatchObject({ status: 'closed', closedAt: '2026-08-04T10:00:00.000Z' });
  });

  // `null` is a MEASUREMENT: the poller looked and this property has no review
  // bead at all.
  it('stores an explicit null as the answer it is', async () => {
    const stored = await storedProject({ projects: [project({ panelReview: null })] });
    expect('panelReview' in stored).toBe(true);
    expect(stored.panelReview).toBeNull();
  });

  // Absence is the OTHER answer: this poller did not look. One-generation skew
  // (see the module header) — a runner that has not been restarted since this
  // field shipped must keep filing snapshots.
  it('accepts a poller that has never heard of a panel review', async () => {
    const stored = await storedProject({ projects: [project()] });
    expect('panelReview' in stored).toBe(false);
  });

  it('rejects a review with no panel day (422)', async () => {
    const res = await post({
      projects: [project({ panelReview: { ...REVIEW, panelDate: 'last monday' } })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.panelReview.panelDate');
  });

  it('rejects a status outside open/closed (422)', async () => {
    const res = await post({
      projects: [project({ panelReview: { ...REVIEW, status: 'in_progress' } })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.panelReview.status');
  });

  // An open review carrying a close time is a contradiction, not skew: the
  // producer read both fields off one bead. Stored as-is it would let a card
  // claim triage that nobody has finished.
  it('rejects an open review that also claims it was closed (422)', async () => {
    const res = await post({
      projects: [project({ panelReview: { ...REVIEW, closedAt: '2026-08-04T10:00:00.000Z' } })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.panelReview.closedAt');
  });

  it('rejects a review that is neither an object nor null (422)', async () => {
    const res = await post({ projects: [project({ panelReview: 'reviewed' })] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.panelReview');
  });

  // A garbled review must not be stored as "nothing to review" — the more
  // comfortable of the two lies.
  it('stores nothing at all when the review is malformed', async () => {
    await post({ projects: [project({ panelReview: { beadId: '' } })] });
    expect(await snapshots()).toBe(0);
  });
});

// Work filed from a Tower handoff, joined back to the finding that raised it.
// The key is the finding's own — byte-exact, because that is what the surface
// matches on.
describe('POST /api/beads-snapshot — handoff beads', () => {
  const HANDOFF = {
    kind: 'finding',
    key: 'item-openers',
    beadId: 'mp-1w2',
    status: 'open',
    closedAt: null,
  };

  async function storedProject(body: unknown): Promise<Record<string, unknown>> {
    const res = await post(body);
    expect(res.status).toBe(201);
    const [row] = await storedRows();
    return (JSON.parse(row!.payload) as { projects: Record<string, unknown>[] }).projects[0]!;
  }

  it('stores the filed work exactly as the finding card will read it', async () => {
    const stored = await storedProject({ projects: [project({ handoffs: [HANDOFF] })] });
    expect(stored.handoffs).toEqual([HANDOFF]);
  });

  // A query's key IS the normalized query, so it carries whatever the searcher
  // typed — punctuation, commas, quotes. The label on the bead is a lossy slug
  // and only this field can be matched against a rendered row.
  it('keeps a key byte-exact, punctuation and all', async () => {
    const key = 'best "meal plan", weekly — 2026';
    const stored = await storedProject({
      projects: [project({ handoffs: [{ ...HANDOFF, kind: 'query', key }] })],
    });
    expect((stored.handoffs as { key: string }[])[0]!.key).toBe(key);
  });

  it('stores a closed bead with the instant the work shipped', async () => {
    const stored = await storedProject({
      projects: [
        project({
          handoffs: [{ ...HANDOFF, status: 'closed', closedAt: '2026-08-02T10:00:00.000Z' }],
        }),
      ],
    });
    expect(stored.handoffs).toEqual([
      { ...HANDOFF, status: 'closed', closedAt: '2026-08-02T10:00:00.000Z' },
    ]);
  });

  // `[]` is a MEASUREMENT: the poller asked this property's register and nobody
  // has filed anything. It is the only thing that lets a finding card present
  // itself as untouched work, so it must survive as an empty list.
  it('stores an empty list as the answer it is', async () => {
    const stored = await storedProject({ projects: [project({ handoffs: [] })] });
    expect('handoffs' in stored).toBe(true);
    expect(stored.handoffs).toEqual([]);
  });

  // Absence is the OTHER answer: this poller never asked. One-generation skew
  // (see the module header) — the runner keeps filing snapshots until the
  // operator restarts it, and every one of them must be accepted.
  it('accepts a poller that has never heard of a handoff bead', async () => {
    const stored = await storedProject({ projects: [project()] });
    expect('handoffs' in stored).toBe(false);
  });

  // All four surfaces the emitter writes: a surface missing from this list
  // 422s every snapshot from a property carrying one of its beads.
  it('stores every surface that can file work, page and alert included', async () => {
    const stored = await storedProject({
      projects: [
        project({
          handoffs: [
            { ...HANDOFF, kind: 'page', key: 'https://meals.example/recipes', beadId: 'mp-pg1' },
            { ...HANDOFF, kind: 'alert', key: 'flag-8812', beadId: 'mp-al1' },
          ],
        }),
      ],
    });
    expect(stored.handoffs).toEqual([
      { kind: 'page', key: 'https://meals.example/recipes', beadId: 'mp-pg1', status: 'open', closedAt: null },
      { kind: 'alert', key: 'flag-8812', beadId: 'mp-al1', status: 'open', closedAt: null },
    ]);
  });

  // The emitter ships independently of this Worker, so an unfamiliar kind is
  // the ordinary sound of a newer surface arriving, and it may only cost its
  // own marker — never the project's whole list.
  it('drops a row whose kind it has never heard of and stores the rest', async () => {
    const stored = await storedProject({
      projects: [
        project({
          handoffs: [HANDOFF, { ...HANDOFF, kind: 'sitemap', beadId: 'mp-zz9', key: 'whatever' }],
        }),
      ],
    });
    expect(stored.handoffs).toEqual([HANDOFF]);
  });

  // The project survives the drop whole — counts, queue, and every other list.
  // A partial store here would be the same outage wearing a smaller hat.
  it('keeps the rest of the project intact around a dropped row', async () => {
    const stored = await storedProject({
      projects: [project({ handoffs: [{ ...HANDOFF, kind: 'sitemap' }] })],
    });
    expect(stored.handoffs).toEqual([]);
    expect(stored.counts).toEqual({
      open: 2,
      highPriority: 1,
      ready: 1,
      inProgress: 1,
      blocked: 0,
      closedRecent: 0,
    });
    expect((stored.ready as unknown[]).length).toBe(1);
    expect((stored.inProgress as unknown[]).length).toBe(1);
  });

  // A kind that is absent, empty, or not a string is not a surface a later Tower
  // invented — it is a row too malformed to name one, and the producer bug it
  // reports is worth a 422.
  it('still rejects a kind that names no surface at all (422)', async () => {
    for (const kind of [undefined, '', 7]) {
      await reset();
      const res = await post({
        projects: [project({ handoffs: [{ ...HANDOFF, kind }] })],
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as ValidationBody;
      expect(body.issues[0]!.path).toBe('projects.0.handoffs.0.kind');
    }
  });

  // Built apart from the printing because a test inside workerd cannot see the
  // lane's own console. ONE line per snapshot, naming the kind and the bead —
  // the skew is otherwise invisible, since it degrades into a marker that simply
  // never appears.
  it('names the dropped kind and bead in one line per snapshot', () => {
    expect(
      droppedHandoffEvent([
        { asset: 'meals.example', kind: 'sitemap', beadId: 'mp-zz9' },
        { asset: 'nosh.example', kind: 'sitemap', beadId: 'nom-4b1' },
      ]),
    ).toEqual({
      event: 'beads_handoff_kind_unknown',
      dropped: [
        { asset: 'meals.example', kind: 'sitemap', beadId: 'mp-zz9' },
        { asset: 'nosh.example', kind: 'sitemap', beadId: 'nom-4b1' },
      ],
    });
  });

  // `bd`'s richer statuses collapse to two upstream, so this enum is the OS's
  // own vocabulary and not the tracker's — a third value is a producer bug.
  it('rejects a status outside open/closed (422)', async () => {
    const res = await post({
      projects: [project({ handoffs: [{ ...HANDOFF, status: 'in_progress' }] })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.handoffs.0.status');
  });

  it('rejects an open bead that also claims it was closed (422)', async () => {
    const res = await post({
      projects: [project({ handoffs: [{ ...HANDOFF, closedAt: '2026-08-02T10:00:00.000Z' }] })],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.handoffs.0.closedAt');
  });

  it('rejects a bead with no key to join on (422)', async () => {
    const res = await post({ projects: [project({ handoffs: [{ ...HANDOFF, key: '' }] })] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.handoffs.0.key');
  });

  // A project the poller could not read reports NO filed work either: claiming
  // any beside an error is how a half-read repo looks answered.
  it('rejects a failed project that still carries filed work (422)', async () => {
    const res = await post({
      projects: [
        project({
          ok: false,
          error: 'bd handoffs exited 1',
          counts: { open: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0 },
          ready: [],
          inProgress: [],
          recentlyClosed: [],
          handoffs: [HANDOFF],
        }),
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues[0]!.path).toBe('projects.0.ok');
  });

  // A garbled entry must not be stored as "nothing was filed" — the more
  // comfortable of the two lies, and the one that makes a card call filed work
  // untouched.
  it('stores nothing at all when one bead is malformed', async () => {
    await post({ projects: [project({ handoffs: [HANDOFF, { kind: 'finding' }] })] });
    expect(await snapshots()).toBe(0);
  });
});

describe('POST /api/beads-snapshot — bounded history', () => {
  it('drops snapshots older than the retention window on insert', async () => {
    const dayMs = 86_400_000;
    await seedSnapshot(new Date(Date.now() - 9 * dayMs).toISOString());
    await seedSnapshot(new Date(Date.now() - 3 * dayMs).toISOString());
    await seedSnapshot(new Date(Date.now() - 1 * dayMs).toISOString());
    expect(await snapshots()).toBe(3);

    // A distinct board, so this exercises the insert path — the seeds are all
    // `{projects: []}` and an identical post would touch instead.
    const res = await post({ projects: [project()] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as SnapshotBody).pruned).toBe(2);
    // The 3- and 9-day-old rows go; the 1-day-old one and the new one stay.
    expect(await snapshots()).toBe(2);
    expect(BEADS_SNAPSHOT_RETENTION_DAYS).toBe(2);
  });

  // The Wall's feed replays photographs back to 6 PM the day before, local
  // time — 31 hours at most (apps/tower/test/wall-feed.test.ts pins that side).
  // Retention shorter than that would silently empty the feed's early evening.
  it('keeps every photograph the Wall feed can still replay', () => {
    expect(WALL_FEED_REACH_HOURS).toBe(31);
    expect(BEADS_SNAPSHOT_RETENTION_DAYS * 24).toBeGreaterThan(WALL_FEED_REACH_HOURS);
  });

  it('keeps a snapshot that is inside the window', async () => {
    await seedSnapshot(new Date(Date.now() - 1 * 86_400_000).toISOString());
    const res = await post({ projects: [project()] });
    expect(((await res.json()) as SnapshotBody).pruned).toBe(0);
    expect(await snapshots()).toBe(2);
  });

  // A write is never reported as successful and then silently undone.
  it('never prunes the row it just wrote, however backdated', async () => {
    const res = await post({
      capturedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      projects: [],
    });
    expect(res.status).toBe(201);
    expect(await snapshots()).toBe(1);
  });
});

// Only the newest row and two lists of the last day's rows are ever read, so
// that is all a replaced photograph keeps.
describe('POST /api/beads-snapshot — keeps only what is read', () => {
  const HOUR_MS = 3_600_000;
  const FILED = { kind: 'finding', key: 'item-openers', beadId: 'mp-1w2', status: 'open', closedAt: null };

  /** A board that differs from every other one, as a busy portfolio's does. */
  function board(n: number) {
    return {
      projects: [
        project({
          counts: { open: n, highPriority: 1, ready: 1, inProgress: 1, blocked: 0, closedRecent: 1 },
          recentlyClosed: [issue({ id: `mp-c${n}`, status: 'closed', closedAt: '2026-08-01T10:00:00Z' })],
          recentlyCreated: [issue({ id: `mp-n${n}`, createdAt: '2026-08-01T09:00:00Z' })],
          epics: [],
          deferred: [issue({ id: `mp-d${n}`, status: 'deferred' })],
          handoffs: [FILED],
        }),
      ],
    };
  }

  it('repeated filings leave a bounded row count', async () => {
    // Five days of a board that changes every hour, filed through the writer
    // with its own clock so the days really pass.
    const start = Date.now() - 5 * 24 * HOUR_MS;
    const bound = BEADS_SNAPSHOT_RETENTION_DAYS * 24 + 1;
    const counts: number[] = [];
    for (let hour = 0; hour <= 5 * 24; hour += 1) {
      const nowMs = start + hour * HOUR_MS;
      const result = await writeBeadsSnapshot(
        env,
        { capturedAt: new Date(nowMs).toISOString(), ...board(hour) },
        nowMs,
      );
      expect(result.ok).toBe(true);
      counts.push(await snapshots());
    }
    // It grows to the window and stays there, never past it.
    expect(Math.max(...counts)).toBeLessThanOrEqual(bound);
    expect(counts.at(-1)).toBe(bound);
    expect(counts.at(-1)).toBe(counts.at(-25));

    // Only the newest row is whole; every older one holds just what is read.
    const [newest, ...older] = await storedRows();
    const whole = JSON.parse(newest!.payload) as { projects: Record<string, unknown>[] };
    expect(whole.projects[0]).toHaveProperty('ready');
    expect(whole.projects[0]).toHaveProperty('handoffs');
    for (const row of older) {
      expect(row.payload.length).toBeLessThan(newest!.payload.length / 2);
    }
  });

  it('a replaced photograph keeps only what the Wall feed and the daily backfill read', async () => {
    await post({ capturedAt: FIRST_TICK, ...board(1) });
    await post({ capturedAt: SECOND_TICK, ...board(2) });

    const [newest, replaced] = await storedRows();
    expect(JSON.parse(newest!.payload).projects[0]).toMatchObject({
      counts: { open: 2 },
      ready: [{ id: 'mp-1w2' }],
      deferred: [{ id: 'mp-d2' }],
      handoffs: [{ beadId: FILED.beadId }],
    });
    const kept = JSON.parse(replaced!.payload) as { projects: Record<string, unknown>[] };
    expect(kept).toEqual({
      projects: [
        {
          asset: 'meals.example',
          ok: true,
          counts: { open: 1, highPriority: 1, ready: 1, inProgress: 1, blocked: 0, closedRecent: 1 },
          recentlyClosed: [{ id: 'mp-c1', title: 'Fix the recipe schema', closedAt: '2026-08-01T10:00:00.000Z' }],
          recentlyCreated: [{ id: 'mp-n1', title: 'Fix the recipe schema', createdAt: '2026-08-01T09:00:00.000Z' }],
        },
      ],
    });
    // The daily rollup's backfill still reads a replaced photograph.
    expect(readSnapshotProjects(replaced!.payload)).toEqual([
      {
        asset: 'meals.example',
        ok: true,
        counts: { open: 1, inProgress: 1, blocked: 0, highPriority: 1, waiting: undefined },
        recentlyClosed: [{ id: 'mp-c1', closedAt: '2026-08-01T10:00:00.000Z' }],
      },
    ]);
  });

  it('a capture that lands behind the newest row never replaces it', async () => {
    await post({ capturedAt: SECOND_TICK, ...board(2) });
    await post({ capturedAt: FIRST_TICK, ...board(1) });

    const [newest, late] = await storedRows();
    expect(newest!.captured_at).toBe(SECOND_TICK);
    expect(JSON.parse(newest!.payload).projects[0]).toHaveProperty('ready');
    expect(late!.captured_at).toBe(FIRST_TICK);
    expect(JSON.parse(late!.payload).projects[0]).not.toHaveProperty('ready');
  });

  it('an unchanged board seen late never walks the newest row backwards', async () => {
    await post({ capturedAt: FIRST_TICK, ...board(1) });
    await post({ capturedAt: SECOND_TICK, ...board(2) });
    await post({ capturedAt: FIRST_TICK, ...board(2) });

    const [newest] = await storedRows();
    expect(newest!.captured_at).toBe(SECOND_TICK);
    expect(JSON.parse(newest!.payload).projects[0]).toHaveProperty('ready');
  });

  it('leaves an unreadable payload exactly as it is', () => {
    expect(supersededPayload('not json')).toBe('not json');
    expect(supersededPayload('{"other":1}')).toBe('{"other":1}');
  });
});

// Newly filed work: the poller sends each bead's filing time and a short
// newest-filed list, so the Wall feed can say "New task". Both are optional
// under the one-generation-skew rule.
describe('POST /api/beads-snapshot — newly filed work', () => {
  async function storedProject(body: unknown): Promise<Record<string, unknown>> {
    const res = await post(body);
    expect(res.status).toBe(201);
    const [row] = await storedRows();
    return (JSON.parse(row!.payload) as { projects: Record<string, unknown>[] }).projects[0]!;
  }

  it('stores the filing time and the newest-filed list as the feed will read them', async () => {
    const filed = issue({ id: 'mp-new', createdAt: '2026-08-01T08:59:00Z' });
    const stored = await storedProject({ projects: [project({ recentlyCreated: [filed], ready: [filed] })] });
    expect(stored.recentlyCreated).toEqual([{ ...filed, createdAt: '2026-08-01T08:59:00.000Z' }]);
    expect((stored.ready as Record<string, unknown>[])[0]!.createdAt).toBe('2026-08-01T08:59:00.000Z');
  });

  it('accepts a poller that sends neither, and stores no key for them', async () => {
    const stored = await storedProject({ projects: [project()] });
    expect('recentlyCreated' in stored).toBe(false);
    expect('createdAt' in (stored.ready as Record<string, unknown>[])[0]!).toBe(false);
  });

  it('rejects a filing time that is not an instant (422)', async () => {
    const res = await post({ projects: [project({ recentlyCreated: [issue({ createdAt: 'yesterday' })] })] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ValidationBody;
    expect(body.issues.map((i) => i.path)).toContain('projects.0.recentlyCreated.0.createdAt');
  });

  it('bounds the list like every other list (422)', async () => {
    const many = Array.from({ length: BEADS_MAX_ITEMS + 1 }, (_, i) => issue({ id: `mp-${i}` }));
    const res = await post({ projects: [project({ recentlyCreated: many })] });
    expect(res.status).toBe(422);
  });

  it('rejects a failed project that still claims newly filed work (422)', async () => {
    const res = await post({
      projects: [project({ ok: false, error: 'bd failed', ready: [], inProgress: [], recentlyCreated: [issue()] })],
    });
    expect(res.status).toBe(422);
  });
});
