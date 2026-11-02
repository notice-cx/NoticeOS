// The queue that carries a verdict back to the task that is owed it.
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
import type { CompletedWatchReview, WatchReview } from '../src/watch-readbacks.js';
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
  // On Postgres, where the collectors write them.
  await storeSignalRun(
    {
      id: runId,
      asset: 'meadow.example',
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
  // On Postgres, written as the application writes.
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.watch_windows
         (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, scope, registered_at,
          baseline_start, baseline_end, check_offsets, thresholds,
          status, outcome, closed_at, note, outcome_note, readback_bead, readback_posted_at)
       VALUES ($1::uuid, $2, 'meadow.example', 'manual', 'F14', 'gsc', 'position', $3::jsonb,
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
        overrides.bead === undefined ? 'md-w1n.2' : overrides.bead,
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
      asset: 'meadow.example',
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
      readback_bead: 'md-w1n.2',
    });
    expect(registration.ok).toBe(true);

    // Nothing is owed while the window is open.
    expect(await pending()).toEqual([]);

    const swept = await runWatchWindows(env, FINAL_RUN_MS);
    expect(swept.closed[0]).toMatchObject({ outcome: 'ship_confirmed' });

    const queue = await pending();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ bead: 'md-w1n.2', asset: 'meadow.example', outcome: 'ship_confirmed' });
    // The comment carries the bet, the reading and where the same numbers live.
    expect(queue[0]?.comment).toContain('Watch window ship_confirmed — meadow.example');
    expect(queue[0]?.comment).toContain('F14 — water-intake depth + snippet');
    expect(queue[0]?.comment).toContain('gsc/clicks, property-wide');
    expect(queue[0]?.comment).toContain('+30%');
    expect(queue[0]?.comment).toContain('A flag carrying the same numbers is on the meadow.example card');
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

async function outcomeAlert(windowId: string, rule = 'watch-window-closed', outcome = 'inconclusive'): Promise<number> {
  const [row] = await env.STORE.write((tx) => tx.query<{ id: number }>(
    `INSERT INTO noticeos.flags (workspace_id,asset_id,fired_at,severity,kind,rule_id,rule_inputs)
     VALUES ($1::uuid,'meadow.example','2026-08-21T03:30:00Z','info','anomaly',$2,$3::jsonb)
     RETURNING flag_number::int AS id`,
    [tx.workspaceId, rule, JSON.stringify({ watchWindowId: windowId, outcome, measured: 0 })],
  ));
  return row!.id;
}

async function reviews(after: number = 0): Promise<{ reviews: WatchReview[]; nextReviewAfter: number | null }> {
  const res = await call(new Request(`https://ingest.local/api/watch-readbacks?reviewsAfter=${after}`,
    { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } }));
  expect(res.status).toBe(200);
  return res.json();
}

function completion(review: WatchReview, overrides: Partial<CompletedWatchReview> = {}): CompletedWatchReview {
  return { ...review, checkedAt: new Date().toISOString(), closedAt: '2026-08-22T04:00:00.000Z',
    reason: 'Keep; review evidence in abc1234', ...overrides };
}

async function complete(list: CompletedWatchReview[]): Promise<{ reviewed: number[]; skipped: number[] }> {
  const res = await call(request({ method: 'POST', token: OPERATOR_TOKEN, body: JSON.stringify({ reviewed: list }) }));
  expect(res.status).toBe(200);
  return res.json();
}

async function reviewFixture(outcome = 'inconclusive') {
  const windowId = await closedWindow({ posted: '2026-08-21T04:00:00.000Z', outcome });
  await env.STORE.write(tx => tx.execute(
    `INSERT INTO noticeos.watch_window_readings
      (workspace_id,window_id,offset_days,check_date,checked_at,final,baseline,post,delta_pct,pre_change_days)
     VALUES ($1::uuid,$2,7,'2026-08-21','2026-08-21T03:30:00Z',true,'{"value":10}','{"value":10}',0,0)`,
    [tx.workspaceId, windowId]));
  const id = await outcomeAlert(windowId, 'watch-window-closed', outcome);
  const review = (await reviews()).reviews.find(row => row.flagNumber === id)!;
  expect(review).toMatchObject({ flagNumber: id, windowId, bead: 'md-w1n.2' });
  return { windowId, id, review };
}

async function evidence() {
  return env.STORE.read(async (tx) => ({
    windows: await tx.query('SELECT to_jsonb(w) AS row FROM noticeos.watch_windows w ORDER BY window_id'),
    readings: await tx.query('SELECT to_jsonb(r) AS row FROM noticeos.watch_window_readings r ORDER BY window_id, offset_days'),
    flags: await tx.query('SELECT flag_number::int AS id, rule_id, rule_inputs, severity, message, resolved_at FROM noticeos.flags ORDER BY flag_number'),
  }));
}

describe('outcome review completion', () => {
  it.each(['ship_confirmed', 'kill_confirmed', 'inconclusive', 'unmeasurable'])(
    'settles only the associated %s alert, retaining its result and measurements', async (outcome) => {
    const { review, id, windowId } = await reviewFixture(outcome);
    const other = await closedWindow({ posted: '2026-08-21T04:00:00.000Z', bead: 'md-w1n.3', outcome: 'unmeasurable' });
    const otherAlert = await outcomeAlert(other, 'watch-window-closed', 'unmeasurable');
    const unrelated = await outcomeAlert(windowId, 'another-rule');
    const before = await evidence();
    expect(await complete([completion(review)])).toEqual({ reviewed: [id], skipped: [] });
    expect(await evidence()).toEqual(before);
    const rows = await env.STORE.read(tx => tx.query<{ id: number; disposition: string | null; note: string | null }>(
      'SELECT flag_number::int AS id, disposition, disposition_note AS note FROM noticeos.flags ORDER BY flag_number'));
    expect(rows).toEqual([
      { id, disposition: 'ack', note: expect.stringContaining('Outcome reviewed on task') },
      { id: otherAlert, disposition: null, note: null }, { id: unrelated, disposition: null, note: null },
    ]);
    expect((await reviews()).reviews.map(row => row.flagNumber)).toEqual([otherAlert]);
  });

  it('does not queue a result before delivery or without its exact alert association', async () => {
    const unposted = await closedWindow();
    await outcomeAlert(unposted);
    const noTask = await closedWindow({ bead: null, posted: '2026-08-21T04:00:00.000Z' });
    await outcomeAlert(noTask);
    const missingAlert = await closedWindow({ posted: '2026-08-21T04:00:00.000Z' });
    await outcomeAlert(missingAlert, 'another-rule');
    expect((await reviews()).reviews).toEqual([]);
  });

  it('leaves early, stale, future and mismatched completion evidence unsettled', async () => {
    const { review, id } = await reviewFixture();
    const now = Date.now();
    for (const bad of [
      { closedAt: review.postedAt }, { closedAt: '2026-08-20T04:00:00.000Z' },
      { closedAt: 'invalid' }, { checkedAt: new Date(now - 600_000).toISOString() },
      { checkedAt: new Date(now + 600_000).toISOString() }, { closedAt: new Date(now + 600_000).toISOString() },
      { asset: 'northwind.example' }, { bead: 'md-w1n.9' }, { windowId: 'another-window' },
      { postedAt: '2026-08-21T04:01:00.000Z' },
    ]) {
      expect(await complete([completion(review, bad)])).toEqual({ reviewed: [], skipped: [id] });
    }
    expect((await reviews()).reviews.map(row => row.flagNumber)).toEqual([id]);
  });

  it('rechecks a changed task link and delivery stamp before acknowledging', async () => {
    const { review, windowId, id } = await reviewFixture();
    await env.STORE.write(tx => tx.execute("UPDATE noticeos.watch_windows SET readback_bead = 'md-w1n.9' WHERE window_id = $1", [windowId]));
    expect(await complete([completion(review)])).toEqual({ reviewed: [], skipped: [id] });
  });

  it('keeps repeats and concurrent completion attempts idempotent', async () => {
    const { review, id } = await reviewFixture();
    const results = await Promise.all([complete([completion(review)]), complete([completion(review)])]);
    expect(results.flatMap(result => result.reviewed)).toEqual([id]);
    expect(await complete([completion(review)])).toEqual({ reviewed: [], skipped: [id] });
    const audit = await env.STORE.read(tx => tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM noticeos.workspace_mutation_audit WHERE event = 'flag.acknowledge'"));
    expect(audit[0]?.n).toBe(1);
  });

  it.each(['snooze', 'tune'])('completes a %s review and preserves its rule tune', async (disposition) => {
    const { review, id } = await reviewFixture();
    await env.STORE.write(tx => tx.execute(
      `UPDATE noticeos.flags SET disposition=$2, snooze_until='2099-01-01', disposition_note=$3 WHERE flag_number=$1`,
      [id, disposition, disposition === 'tune' ? 'Longest window 7 → 28' : 'Snoozed by operator · rule tuned: Longest window 7 → 28']));
    expect(await complete([completion(review)])).toEqual({ reviewed: [id], skipped: [] });
    const [row] = await env.STORE.read(tx => tx.query<{ note: string; snooze: string | null }>(
      'SELECT disposition_note AS note, snooze_until AS snooze FROM noticeos.flags WHERE flag_number=$1', [id]));
    expect(row?.note).toContain(' · rule tuned: Longest window 7 → 28');
    expect(row?.snooze).toBeNull();
  });

  it('pages past unfinished reviews without losing later results', async () => {
    const ids: number[] = [];
    for (let index = 0; index < 51; index++) {
      ids.push(await outcomeAlert(await closedWindow({ posted: '2026-08-21T04:00:00.000Z' })));
    }
    const first = await reviews();
    expect(first.reviews.map(row => row.flagNumber)).toEqual(ids.slice(0, 50));
    expect(first.nextReviewAfter).toBe(ids[49]);
    const second = await reviews(first.nextReviewAfter!);
    expect(second.reviews.map(row => row.flagNumber)).toEqual(ids.slice(50));
    expect(second.nextReviewAfter).toBeNull();
  });

  it('rejects unauthenticated, malformed and oversized review writes', async () => {
    const { review } = await reviewFixture();
    expect((await call(request({ method: 'POST', body: JSON.stringify({ reviewed: [completion(review)] }) }))).status).toBe(401);
    for (const reviewed of [[{ windowId: review.windowId }], Array(51).fill(completion(review)), [completion(review, { reason: ' ' })]]) {
      expect((await call(request({ method: 'POST', token: OPERATOR_TOKEN, body: JSON.stringify({ reviewed }) }))).status).toBe(400);
    }
  });
});
