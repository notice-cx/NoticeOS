// `runScheduled()` — the local runner's cron fire — must be the same event as a
// real Cloudflare cron.
//
// The ingest has no listener of its own locally: it runs as an auxiliary
// Worker inside the Tower's workerd, so the runner fires this RPC through the
// Tower's private Service Binding instead of GETting
// `/cdn-cgi/handler/scheduled` at a second process. If that path ever
// dispatched differently from `scheduled()`, every local rehearsal would be
// rehearsing something the deployed Worker does not do.
//
// The freshness lane is the one used here because it is pure store work: no
// provider call, no credential, so whether the event actually ran is a row in
// `flags`.

import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IngestWorker from '../src/index.js';
import { FRESHNESS_CRON } from '../src/crons.js';
import { insertPulse, pgCount, reset } from './helpers.js';

const HOUR = 3_600_000;

function worker(): IngestWorker {
  return new IngestWorker(createExecutionContext(), env);
}

/** A pulse old enough that the freshness lane must flag it. */
async function insertStalePulse(asset: string): Promise<void> {
  const iso = new Date(Date.now() - 400 * HOUR).toISOString();
  await insertPulse({ asset, date: '2026-07-03', generatedAt: iso, receivedAt: iso });
}

async function openFreshnessFlags(): Promise<number> {
  return pgCount(
    `SELECT count(*) AS n FROM noticeos.current_flags WHERE rule_id = 'ingest-freshness' AND resolved_at IS NULL`,
  );
}

describe('the runner cron RPC', () => {
  beforeEach(reset);
  // The hourly tick also checks every site's home page. Every site answers
  // here, so the suite asks the real network nothing.
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('<html><body>up</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the lane the expression names, exactly as the scheduled handler would', async () => {
    await insertStalePulse('meadow.example');
    await worker().runScheduled(FRESHNESS_CRON);
    expect(await openFreshnessFlags()).toBeGreaterThan(0);
  });

  it('is the same event as a real cron, not a parallel implementation', async () => {
    await insertStalePulse('meadow.example');
    await worker().scheduled({ cron: FRESHNESS_CRON } as ScheduledController);
    const viaScheduled = await openFreshnessFlags();

    await reset();
    await insertStalePulse('meadow.example');
    await worker().runScheduled(FRESHNESS_CRON);
    const viaRpc = await openFreshnessFlags();

    expect(viaRpc).toBe(viaScheduled);
    expect(viaRpc).toBeGreaterThan(0);
  });

  it('checks each site is up on the same hourly tick', async () => {
    await worker().runScheduled(FRESHNESS_CRON);
    // The site checks' readings are on Postgres.
    const [row] = await env.STORE.read((tx) =>
      tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM noticeos.hygiene_checks WHERE check_id = 'html-depth' AND status = 'ok'`,
      ),
    );
    expect(row?.n ?? 0).toBeGreaterThan(0);
  });
});
