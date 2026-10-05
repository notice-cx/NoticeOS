// The queue that carries a verdict back to the bead that is owed it (db/0024).
//
// The end-to-end case runs the real sweep, because the thing worth pinning is
// that closing a window ENQUEUES its verdict without the sweep knowing anything
// about beads. The mechanics below it are driven off hand-written rows: the
// queue does not care how a window closed, only that it did.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runWatchWindows } from '../src/watch-windows.js';
import { writeWatchWindow } from '../src/routes/watch-windows.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call, reset, storeSignalRun } from './helpers.js';

beforeEach(reset);

const DAY_MS = 86_400_000;
const FINAL_RUN_MS = Date.parse('2026-07-08T03:30:00.000Z');

function request(init: RequestInit & { token?: string } = {}): Request {
  const { token, ...rest } = init;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('https://ingest.local/api/watch-readbacks', { headers, ...rest });
}

async function pending(): Promise<
  { windowId: string; bead: string; asset: string; outcome: string; comment: string }[]
> {
  const res = await call(request({ token: OPERATOR_TOKEN }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { pending: never[] };
  return body.pending;
}

async function post(ids: string[]): Promise<{ posted: string[]; skipped: string[] }> {
  const res = await call(
    request({ method: 'POST', body: JSON.stringify({ posted: ids }), token: OPERATOR_TOKEN }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { posted: string[]; skipped: string[] };
}

/** Daily GSC clicks: `baseline`/day through the change, `post`/day after it. */
async function observeClicks(baseline: number, post: number): Promise<void> {
  const runId = crypto.randomUUID();
  const dates: string[] = [];
  for (
    let ms = Date.parse('2026-06-24T00:00:00.000Z');
    ms <= Date.parse('2026-07-08T00:00:00.000Z');
    ms += DAY_MS
  ) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  // On Postgres, where the collectors write them (bead ro-ujb9.76.5.3).
  await storeSignalRun(
    {
      id: runId,
      asset: 'meals.example',
      integration: 'gsc',
      credential_ref: 'test-account',
      property_ref: 'test-property',
      finished_at: '2026-07-08T02:45:00.000Z',
      window_start: dates[0]!,
      window_end: dates[dates.length - 1]!,
    },
    dates.map((date) => ({ date, metric: 'clicks', value: date <= '2026-07-01' ? baseline : post })),
  );
}

/** A window already closed, with whatever the queue is being asked about. */
async function closedWindow(
  overrides: {
    id?: string;
    bead?: string | null;
    status?: string;
    outcome?: string | null;
    posted?: string | null;
    scope?: string | null;
  } = {},
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const closed = (overrides.status ?? 'closed') === 'closed';
  // On Postgres (bead ro-ujb9.76.5.7), written as the application writes.
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.watch_windows
         (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, scope, registered_at,
          baseline_start, baseline_end, check_offsets, thresholds,
          status, outcome, closed_at, note, outcome_note, readback_bead, readback_posted_at)
       VALUES ($1::uuid, $2, 'meals.example', 'manual', 'F14', 'gsc', 'position', $3::jsonb,
               '2026-07-01T12:00:00.000Z', '2026-06-24', '2026-06-30', '{7}', NULL,
               $4, $5, $6::timestamptz, 'F14 — water-intake depth + snippet',
               'gsc/position for page /water-intake-calculator at +7d: 8.5/day vs baseline 7.8/day (+9%)',
               $7, $8::timestamptz)`,
      [
        tx.workspaceId,
        id,
        overrides.scope ?? '{"page":"/water-intake-calculator"}',
        overrides.status ?? 'closed',
        closed ? (overrides.outcome ?? 'kill_confirmed') : null,
        closed ? '2026-08-21T03:30:00.000Z' : null,
        overrides.bead === undefined ? 'mp-f0g.35' : overrides.bead,
        overrides.posted ?? null,
      ],
    ),
  );
  return id;
}

describe('GET /api/watch-readbacks — what has not reached its bead', () => {
  it('refuses without the operator token (401)', async () => {
    expect((await call(request())).status).toBe(401);
  });

  it('enqueues a verdict when the sweep closes a window that named a bead', async () => {
    await observeClicks(10, 13);
    const registration = await writeWatchWindow(env, {
      asset: 'meals.example',
      ref_kind: 'manual',
      ref: 'F14',
      metric_integration: 'gsc',
      metric: 'clicks',
      registered_at: '2026-07-01T12:00:00.000Z',
      baseline_start: '2026-06-24',
      baseline_end: '2026-06-30',
      check_offsets: [7],
      thresholds: { ship: { direction: 'up', min_delta_pct: 10 } },
      note: 'F14 — water-intake depth + snippet',
      readback_bead: 'mp-f0g.35',
    });
    expect(registration.ok).toBe(true);

    // Nothing is owed while the window is open.
    expect(await pending()).toEqual([]);

    const swept = await runWatchWindows(env, FINAL_RUN_MS);
    expect(swept.closed[0]).toMatchObject({ outcome: 'ship_confirmed' });

    const queue = await pending();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bead: 'mp-f0g.35', asset: 'meals.example', outcome: 'ship_confirmed' });
    // The comment carries the bet, the reading and where the same numbers live.
    expect(queue[0]?.comment).toContain('Watch window ship_confirmed — meals.example');
    expect(queue[0]?.comment).toContain('F14 — water-intake depth + snippet');
    expect(queue[0]?.comment).toContain('gsc/clicks, property-wide');
    expect(queue[0]?.comment).toContain('+30%');
    expect(queue[0]?.comment).toContain('A flag carrying the same numbers is on the meals.example card');
  });

  it('names the scope a scoped bet was answered on', async () => {
    await closedWindow();
    expect((await pending())[0]?.comment).toContain(
      'gsc/position for page /water-intake-calculator',
    );
  });

  it('leaves out a window nobody claimed, and one already reported', async () => {
    await closedWindow({ bead: null });
    await closedWindow({ posted: '2026-08-21T04:00:00.000Z' });
    await closedWindow({ status: 'open' });
    expect(await pending()).toEqual([]);
  });
});

describe('POST /api/watch-readbacks — what actually landed', () => {
  it('stamps only what it is told, and only once', async () => {
    const first = await closedWindow();
    const second = await closedWindow();
    expect((await pending()).map((entry) => entry.windowId).sort()).toEqual(
      [first, second].sort(),
    );

    expect(await post([first])).toEqual({ posted: [first], skipped: [] });
    expect((await pending()).map((entry) => entry.windowId)).toEqual([second]);

    // Re-posting the same id is a no-op that says so, never a second stamp.
    expect(await post([first])).toEqual({ posted: [], skipped: [first] });
  });

  it('will not stamp a window that has no verdict to report', async () => {
    const open = await closedWindow({ status: 'open' });
    const unclaimed = await closedWindow({ bead: null });
    expect(await post([open, unclaimed, 'not-a-window'])).toMatchObject({ posted: [] });
  });

  it('rejects a body that is not a list of ids (400)', async () => {
    const res = await call(
      request({ method: 'POST', body: JSON.stringify({ posted: 'F14' }), token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(400);
  });
});
