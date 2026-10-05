import { env } from 'cloudflare:test';
import { javascriptInstant } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CRON_RUN_SILENCE_MS,
  JOB_RUN_MAX_BATCH,
  JOB_RUN_RETENTION_DAYS,
  cronRunSuccessValue,
} from '../src/job-runs.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call, reset, storedCount } from './helpers.js';

beforeEach(reset);

const NOW = Date.now();
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

interface JobRunsBody {
  received: number;
  created: number;
  duplicate: number;
  stale: number;
  pruned: number;
}

interface ValidationBody {
  error: string;
  issues: { path: string; code: string; message: string }[];
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    job: 'backup',
    startedAt: ago(3_600_000),
    ms: 12_000,
    outcome: 'ran',
    ...overrides,
  };
}

/** How many firings the store's record holds, of one lane or all. */
async function firings(job?: string): Promise<number> {
  return storedCount('SELECT count(*)::int AS n FROM noticeos.job_runs WHERE $1::text IS NULL OR job = $1', [job ?? null]);
}

/** The stored firings, the first recorded first, instants as JavaScript writes them. */
async function storedRuns() {
  const rows = await env.STORE.read((tx) =>
    tx.query<{
      job: string;
      number: number;
      started_at: string;
      finished_at: string;
      outcome: string;
      scheduled_at: string | null;
      detail: string | null;
    }>(
      `SELECT job, job_run_number::int AS number, started_at, finished_at, outcome, scheduled_at, detail
         FROM noticeos.job_runs ORDER BY job_run_number`,
    ),
  );
  return rows.map((row) => ({ ...row, started_at: javascriptInstant(row.started_at), finished_at: javascriptInstant(row.finished_at) }));
}

/** `null` means "send no bearer at all" — an explicit `undefined` would take the
 * default and quietly test the authenticated path. */
async function post(body: unknown, token: string | null = OPERATOR_TOKEN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return call(
    new Request('https://ingest.local/api/job-runs', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/job-runs — the runner mirrors its record into the store', () => {
  it('refuses an unauthenticated or wrongly-authenticated caller', async () => {
    expect((await post({ runs: [run()] }, null)).status).toBe(401);
    expect((await post({ runs: [run()] }, 'not-the-token')).status).toBe(401);
    expect(await firings()).toBe(0);
  });

  it('stores a batch and derives each firing’s finish from its duration', async () => {
    const res = await post({
      runs: [run(), run({ job: 'beads-snapshot', startedAt: ago(60_000), ms: 800, outcome: 'skipped' })],
    });
    expect(res.status).toBe(201);
    expect((await res.json<JobRunsBody>()).created).toBe(2);

    const row = (await storedRuns()).find((stored) => stored.job === 'backup');
    expect(Date.parse(row!.finished_at) - Date.parse(row!.started_at)).toBe(12_000);
    expect(row!.outcome).toBe('ran');
    // The runner fires on the tick and keeps no second timestamp that would
    // always equal the first (db/0022) — absent stays absent.
    expect(row!.scheduled_at).toBeNull();
    expect(row!.detail).toBeNull();
  });

  it('is idempotent on (job, startedAt), because re-sending is the normal case', async () => {
    // The runner cannot know what got through: a restart re-seeds its queue from
    // the disk file. A duplicate is dropped and counted, never an error — a
    // producer punished for re-sending would learn to forget instead.
    const body = { runs: [run(), run({ job: 'panel-review', outcome: 'skipped' })] };
    expect((await (await post(body)).json<JobRunsBody>()).created).toBe(2);

    const second = await post(body);
    expect(second.status).toBe(201);
    expect(await second.json<JobRunsBody>()).toMatchObject({ received: 2, created: 0, duplicate: 2 });
    expect(await firings()).toBe(2);
  });

  it('gives a re-sent firing no number of its own, so the next new one takes the next number', async () => {
    // The store hands each firing its workspace's next number (the Wall feed's
    // line id). A firing it already holds, or one a batch names twice, is left
    // out before the insert, so re-sending never uses a number up.
    const body = { runs: [run(), run({ job: 'panel-review', outcome: 'skipped' })] };
    await post(body);
    await post(body);
    const twice = await post({
      runs: [run({ job: 'beads-snapshot', startedAt: ago(60_000) }), run({ job: 'beads-snapshot', startedAt: ago(60_000) })],
    });
    expect(await twice.json<JobRunsBody>()).toMatchObject({ received: 2, created: 1, duplicate: 1 });
    // Numbers never go back, so earlier tests in this file have used some.
    const stored = await storedRuns();
    const first = stored[0]!.number;
    expect(stored.map((run) => [run.job, run.number - first])).toEqual([
      ['backup', 0],
      ['panel-review', 1],
      ['beads-snapshot', 2],
    ]);
  });

  it('keeps two firings of the same lane a second apart as two firings', async () => {
    await post({
      runs: [
        run({ job: 'beads-snapshot', startedAt: ago(120_000) }),
        run({ job: 'beads-snapshot', startedAt: ago(60_000) }),
      ],
    });
    expect(await firings('beads-snapshot')).toBe(2);
  });

  it('accepts a lane name it has never seen, because the lane list lives in the runner', async () => {
    const res = await post({ runs: [run({ job: 'cron 45 12 * * 1' })] });
    expect(res.status).toBe(201);
    expect(await firings('cron 45 12 * * 1')).toBe(1);
  });

  it('refuses a fourth outcome — that vocabulary is the OS’s own, not a tracker’s', async () => {
    const res = await post({ runs: [run({ outcome: 'probably fine' })] });
    expect(res.status).toBe(422);
    expect((await res.json<ValidationBody>()).issues[0]?.path).toBe('runs.0.outcome');
    expect(await firings()).toBe(0);
  });

  it('refuses a firing dated in the future', async () => {
    // A record from the future would sit at the top of "what did each lane last
    // do?" forever, which is how a dead lane would go on looking alive.
    const res = await post({ runs: [run({ startedAt: new Date(NOW + 3_600_000).toISOString() })] });
    expect(res.status).toBe(422);
    expect((await res.json<ValidationBody>()).issues[0]?.path).toBe('runs.0.startedAt');
  });

  it('fails the whole batch on one malformed firing, rather than storing the readable half', async () => {
    const res = await post({ runs: [run(), run({ job: 'beads-snapshot', ms: -1 })] });
    expect(res.status).toBe(422);
    expect((await res.json<ValidationBody>()).issues[0]?.path).toBe('runs.1.ms');
    // A half-stored batch would leave the record with holes nobody can see.
    expect(await firings()).toBe(0);
  });

  it('refuses an empty or oversized batch', async () => {
    expect((await post({ runs: [] })).status).toBe(422);
    expect((await post({ runs: 'all of them' })).status).toBe(422);
    const tooMany = Array.from({ length: JOB_RUN_MAX_BATCH + 1 }, (_, i) =>
      run({ startedAt: ago(60_000 * (i + 1)) }),
    );
    expect((await post({ runs: tooMany })).status).toBe(422);
  });

  it('accepts a firing older than the window without storing it', async () => {
    // Accepted, so a catching-up runner is not stuck re-sending it forever; not
    // stored, because a row swept by its own insert is a write reported as
    // successful and silently undone.
    const res = await post({
      runs: [run({ startedAt: ago((JOB_RUN_RETENTION_DAYS + 1) * 86_400_000) }), run()],
    });
    expect(res.status).toBe(201);
    expect(await res.json<JobRunsBody>()).toMatchObject({ received: 2, created: 1, stale: 1 });
    expect(await firings()).toBe(1);
  });

  it('sweeps rows that aged out of the window on every insert', async () => {
    await env.STORE.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.job_runs (workspace_id, job, started_at, finished_at, outcome, recorded_at)
         VALUES ($1::uuid, 'backup', $2::timestamptz, $2::timestamptz, 'ran', $2::timestamptz)`,
        [tx.workspaceId, ago((JOB_RUN_RETENTION_DAYS + 2) * 86_400_000)],
      ),
    );

    const res = await post({ runs: [run()] });
    expect((await res.json<JobRunsBody>()).pruned).toBe(1);
    expect(await firings()).toBe(1);
  });

  it('keeps the error summary, bounded', async () => {
    await post({ runs: [run({ outcome: 'failed', detail: 'sqlite3 not found' })] });
    expect((await storedRuns())[0]!.detail).toBe('sqlite3 not found');

    const res = await post({
      runs: [run({ job: 'panel-refresh', outcome: 'failed', detail: 'x'.repeat(5_000) })],
    });
    expect(res.status).toBe(422);
  });
});

describe('cronRunSuccessValue — the three states asset #0 can honestly report', () => {
  it('is unknown on an empty record, never a manufactured 1', () => {
    expect(cronRunSuccessValue([], NOW)).toBeNull();
  });

  it('is 1 while every lane’s latest firing ran or stood down', () => {
    expect(
      cronRunSuccessValue(
        [
          { job: 'backup', outcome: 'ran', startedAt: ago(9 * 3_600_000) },
          { job: 'beads-snapshot', outcome: 'skipped', startedAt: ago(60_000) },
        ],
        NOW,
      ),
    ).toBe(1);
  });

  it('is 0 when one lane’s latest firing failed, however old and however healthy the rest', () => {
    // A failed lane stays failed until a later firing of that lane says
    // otherwise — this is the bead's acceptance criterion.
    expect(
      cronRunSuccessValue(
        [
          { job: 'beads-snapshot', outcome: 'ran', startedAt: ago(60_000) },
          { job: 'cron 45 12 * * 1', outcome: 'failed', startedAt: ago(6 * 86_400_000) },
        ],
        NOW,
      ),
    ).toBe(0);
  });

  it('is 0 when nothing has fired for a day, because the record only grows while the runner lives', () => {
    expect(
      cronRunSuccessValue([{ job: 'backup', outcome: 'ran', startedAt: ago(CRON_RUN_SILENCE_MS + 1) }], NOW),
    ).toBe(0);
    expect(
      cronRunSuccessValue([{ job: 'backup', outcome: 'ran', startedAt: ago(CRON_RUN_SILENCE_MS - 1) }], NOW),
    ).toBe(1);
  });
});
