import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULED_JOBS } from '../../../scripts/scheduled-jobs.mjs';
import { WORKFLOW_DEFINITIONS } from '../../../scripts/workflow-definitions.mjs';
import { JOB_LANES, UnknownCronError, runCron, runScheduledCron } from '../src/dispatch.js';
import IngestWorker from '../src/index.js';
import { reset } from './helpers.js';

// One list of scheduled jobs. scripts/scheduled-jobs.mts names every job and
// its dispatch key; wrangler.jsonc registers the keys of the jobs the ingest
// runs, and the dispatch table says which lanes each job is. The three are
// pinned to the same jobs here, and any expression outside them is refused by
// name and runs nothing.
//
// `env.TEST_CRONS` is wrangler.jsonc's `triggers.crons`, parsed in
// vitest.config.ts (Node) and injected as a binding: workerd has no node:fs, so
// the test cannot read the file itself.

const INGEST_JOBS = SCHEDULED_JOBS.filter((job) => !job.local);

/** The Tower's steps of the hourly tick (apps/tower/worker/tower-cron.ts): in
 * the job's workflow definition, run by the Tower after the ingest's. */
const TOWER_STEPS = new Set(['connection-counts', 'source-history']);

describe('cron parity', () => {
  it('registers in wrangler.jsonc exactly the dispatch keys of the jobs the ingest runs', () => {
    expect([...env.TEST_CRONS].sort()).toEqual(INGEST_JOBS.map((job) => job.cron).sort());
  });

  it('gives each of those jobs its own key, so one expression never means two jobs', () => {
    expect(new Set(INGEST_JOBS.map((job) => job.cron)).size).toBe(INGEST_JOBS.length);
  });

  it('dispatches exactly those jobs, as the steps each job’s workflow names', () => {
    expect(Object.keys(JOB_LANES).sort()).toEqual(INGEST_JOBS.map((job) => job.id).sort());
    for (const job of INGEST_JOBS) {
      const stages = WORKFLOW_DEFINITIONS.find((definition) => definition.id === job.id)!.stages
        .map((stage) => stage.id)
        .filter((id) => id !== 'config' && id !== 'record' && !TOWER_STEPS.has(id));
      expect(Object.keys(JOB_LANES[job.id]!.steps), job.id).toEqual(stages);
    }
  });
});

/** Every row of every table in the store, counted: a lane that ran leaves one. */
async function storeRowCounts(): Promise<Record<string, number>> {
  return env.STORE.read(async (tx) => {
    const tables = await tx.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'noticeos' ORDER BY tablename",
    );
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM noticeos."${name.replace(/"/g, '""')}"`);
      counts[name] = row!.n;
    }
    return counts;
  });
}

describe('an expression no scheduled job runs on', () => {
  let calls: string[];
  let logged: string[];

  beforeEach(async () => {
    await reset();
    calls = [];
    logged = [];
    // Every provider call, every metered call and every notification goes
    // through fetch: none may happen.
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A typo of a real key, a well-formed expression nobody schedules, a key the
  // runner fires for a job of its own (Search review tasks) and an empty one.
  it.each(['0 * * * * ', '7 7 7 7 7', '25 * * * *', ''])('"%s" runs no lane and is refused as unknown_cron', async (cron) => {
    const before = await storeRowCounts();

    const answer = await runScheduledCron(cron, env);

    expect(answer).toMatchObject({ outcome: 'failed', refused: 'unknown_cron', steps: [] });
    expect(answer.detail).toBe(`No scheduled job runs on "${cron}".`);
    expect(calls).toEqual([]);
    expect(await storeRowCounts()).toEqual(before);
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      { event: 'scheduled_step_failed', cron, step: null, code: 'unknown_cron', message: `No scheduled job runs on "${cron}".` },
    ]);
  });

  it('fails a platform cron by name, before reading any config', async () => {
    const before = await storeRowCounts();
    await expect(runCron('7 7 7 7 7', env)).rejects.toBeInstanceOf(UnknownCronError);
    await expect(new IngestWorker(createExecutionContext(), env).scheduled({ cron: '7 7 7 7 7' } as ScheduledController))
      .rejects.toMatchObject({ code: 'unknown_cron', cron: '7 7 7 7 7' });
    expect(calls).toEqual([]);
    expect(await storeRowCounts()).toEqual(before);
  });
});

describe('each scheduled job’s own expression', () => {
  beforeEach(async () => {
    await reset();
    // Offline: every lane still runs, and each records what it could not reach.
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(INGEST_JOBS.map((job) => [job.label, job] as const))('%s runs its own steps, each one in the run record', async (_label, job) => {
    const answer = await runScheduledCron(job.cron, env);

    expect(answer.refused).toBeUndefined();
    expect(answer.steps?.map((step) => step.id)).toEqual(['config', ...Object.keys(JOB_LANES[job.id]!.steps)]);
    expect(answer.steps?.every((step) => step.state !== 'running')).toBe(true);
  });
});
