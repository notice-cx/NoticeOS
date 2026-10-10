import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  WATCH_MIN_WINDOW_COVERAGE,
  WATCH_SERIES,
  watchScopeRequired,
  type CreateWatchWindowInput,
} from '@noticeos/contract';
import IngestWorker from '../src/index.js';
import {
  MIN_WINDOW_COVERAGE,
  WATCH_METRICS,
  aggregateScopedMetric,
  readWatchQueryHistory,
  runWatchWindows,
  watchSweepEvent,
  type WatchReading,
} from '../src/watch-windows.js';
import { recordSignalSuccess } from '../src/signal-store.js';
import { writeWatchWindow } from '../src/routes/watch-windows.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import type { SqlValue } from '@noticeos/postgres';
import { asOwner, call, insertAnnotation, insertFlag, pgCount, pgRows, reset, storeArchiveRun, storeSignalRun, storedCount } from './helpers.js';

function worker(): IngestWorker {
  return new IngestWorker(createExecutionContext(), env);
}

beforeEach(reset);

// One scenario carries most of these tests: a change registered on 2026-07-01
// against the seven days before it, re-read at +3 (interim) and +7 (final).
const REGISTERED_AT = '2026-07-01T12:00:00.000Z';
const BASELINE_START = '2026-06-24';
const BASELINE_END = '2026-06-30';
/** 03:30 UTC on the final check date — the cron's own slot. */
const FINAL_RUN_MS = Date.parse('2026-07-08T03:30:00.000Z');
/** 03:30 UTC on the interim check date: +3 is due, +7 is not. */
const INTERIM_RUN_MS = Date.parse('2026-07-04T03:30:00.000Z');

const DAY_MS = 86_400_000;

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (
    let ms = Date.parse(`${start}T00:00:00.000Z`);
    ms <= Date.parse(`${end}T00:00:00.000Z`);
    ms += DAY_MS
  ) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

/** Write one successful collector run and its daily observations. */
async function observe(
  asset: string,
  integration: string,
  metric: string,
  values: Record<string, number>,
  finishedAt = '2026-07-08T02:45:00.000Z',
  {
    propertyRef = 'test-property',
    credentialRef = 'test-account',
  }: { propertyRef?: string; credentialRef?: string } = {},
): Promise<void> {
  const runId = crypto.randomUUID();
  const dates = Object.keys(values).sort();
  // On Postgres, where the collectors write them.
  await storeSignalRun(
    {
      id: runId,
      asset,
      integration,
      credential_ref: credentialRef,
      property_ref: propertyRef,
      finished_at: finishedAt,
      window_start: dates[0]!,
      window_end: dates[dates.length - 1]!,
    },
    dates.map((date) => ({ date, metric, value: values[date]! })),
  );
}

/** GSC clicks: `baseline`/day through the change day, `post`/day after it. */
async function observeClicks(baseline: number, post: number, end = '2026-07-08'): Promise<void> {
  const values: Record<string, number> = {};
  for (const date of dateRange(BASELINE_START, end)) {
    values[date] = date <= '2026-07-01' ? baseline : post;
  }
  await observe('meadow.example', 'gsc', 'clicks', values);
}

/** Archive one provider-final GSC query day through the real archive shape. */
async function archiveQueryDay(
  date: string,
  rows: { query: string; clicks: number; impressions?: number; ctr?: number; position?: number }[],
): Promise<void> {
  const envelope = {
    schemaVersion: 1,
    provider: 'google',
    integration: 'gsc',
    report: 'query',
    asset: 'meadow.example',
    credentialRef: 'test-account',
    propertyRef: 'sc-domain:meadow.example',
    reportDate: date,
    collectedAt: `${date}T12:15:00.000Z`,
    dataState: 'provider-final',
    providerRows: rows.length,
    providerTruncated: false,
    pages: [
      {
        request: {
          startDate: date,
          endDate: date,
          dimensions: ['query'],
          dataState: 'final',
        },
        response: {
          rows: rows.map((row) => ({
            keys: [row.query],
            clicks: row.clicks,
            impressions: row.impressions ?? row.clicks * 10,
            ctr: row.ctr ?? 0.1,
            position: row.position ?? 8,
          })),
        },
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const compressed = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const objectKey = `raw/google/gsc/meadow.example/query/${date}/test.json.gz`;
  await env.RAW_SIGNALS.put(objectKey, compressed, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
  });
  await storeArchiveRun({
    id: crypto.randomUUID(), asset: 'meadow.example', integration: 'gsc', report: 'query', credential_ref: 'test-account',
    property_ref: 'sc-domain:meadow.example', report_date: date, finished_at: `${date}T12:15:00.000Z`,
    data_state: 'provider-final', provider_rows: rows.length, request_count: 1, object_key: objectKey,
    content_sha256: 'a'.repeat(64), object_bytes: compressed.byteLength,
  });
}

/** Archive one provider-final GSC page day — `keys[0]` is the absolute URL. */
async function archivePageDay(
  date: string,
  rows: { page: string; clicks: number; position?: number }[],
): Promise<void> {
  const envelope = {
    schemaVersion: 1,
    provider: 'google',
    integration: 'gsc',
    report: 'page',
    asset: 'meadow.example',
    credentialRef: 'test-account',
    propertyRef: 'sc-domain:meadow.example',
    reportDate: date,
    collectedAt: `${date}T12:15:00.000Z`,
    dataState: 'provider-final',
    providerRows: rows.length,
    providerTruncated: false,
    pages: [
      {
        request: { startDate: date, endDate: date, dimensions: ['page'], dataState: 'final' },
        response: {
          rows: rows.map((row) => ({
            keys: [row.page],
            clicks: row.clicks,
            impressions: row.clicks * 10,
            ctr: 0.1,
            position: row.position ?? 8,
          })),
        },
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const compressed = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const objectKey = `raw/google/gsc/meadow.example/page/${date}/test.json.gz`;
  await env.RAW_SIGNALS.put(objectKey, compressed, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
  });
  await storeArchiveRun({
    id: crypto.randomUUID(), asset: 'meadow.example', integration: 'gsc', report: 'page', credential_ref: 'test-account',
    property_ref: 'sc-domain:meadow.example', report_date: date, finished_at: `${date}T12:15:00.000Z`,
    data_state: 'provider-final', provider_rows: rows.length, request_count: 1, object_key: objectKey,
    content_sha256: 'b'.repeat(64), object_bytes: compressed.byteLength,
  });
}

/**
 * `baseline`/day on /meal-plans through the change, `post`/day after — with a
 * decoy page every day, and the host and trailing slash varying the way a real
 * archive's URLs do.
 */
async function archivePageClicks(baseline: number, post: number): Promise<void> {
  const url = (date: string): string =>
    date === '2026-06-25'
      ? 'https://www.meadow.example/meal-plans/'
      : 'https://meadow.example/meal-plans';
  for (const date of dateRange(BASELINE_START, BASELINE_END)) {
    await archivePageDay(date, [
      { page: url(date), clicks: baseline },
      { page: 'https://meadow.example/recipes', clicks: 999 },
    ]);
  }
  for (const date of dateRange('2026-07-02', '2026-07-08')) {
    await archivePageDay(date, [
      { page: url(date), clicks: post },
      { page: 'https://meadow.example/recipes', clicks: 999 },
    ]);
  }
}

async function archiveQueryClicks(baseline: number, post: number): Promise<void> {
  for (const date of dateRange(BASELINE_START, BASELINE_END)) {
    await archiveQueryDay(date, [{ query: 'high protein meal plan', clicks: baseline }]);
  }
  for (const date of dateRange('2026-07-02', '2026-07-08')) {
    await archiveQueryDay(date, [{ query: 'high protein meal plan', clicks: post }]);
  }
}

interface RegisterOverrides {
  scope?: Record<string, unknown> | null;
  thresholds?: unknown;
  check_offsets?: number[];
  baseline_start?: string;
  baseline_end?: string;
  registered_at?: string;
  metric?: string;
  metric_integration?: string;
  asset?: string;
  readback_bead?: string;
}

function watchRequest(body: unknown, opts: { token?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request('https://ingest.local/api/watch-windows', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function registration(overrides: RegisterOverrides = {}): Record<string, unknown> {
  const { scope, ...rest } = overrides;
  return {
    asset: 'meadow.example',
    ref_kind: 'annotation',
    ref: '41',
    metric_integration: 'gsc',
    metric: 'clicks',
    registered_at: REGISTERED_AT,
    baseline_start: BASELINE_START,
    baseline_end: BASELINE_END,
    check_offsets: [3, 7],
    thresholds: {
      ship: { direction: 'up', min_delta_pct: 10 },
      kill: { direction: 'down', min_delta_pct: 10 },
    },
    ...(scope === undefined ? {} : { scope }),
    ...rest,
  };
}

/** Register through the real route, and return the created window's id. */
async function register(overrides: RegisterOverrides = {}): Promise<string> {
  const res = await call(watchRequest(registration(overrides), { token: OPERATOR_TOKEN }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { watch_window: { id: string } };
  return body.watch_window.id;
}

interface StoredWindow extends Record<string, unknown> {
  status: string;
  outcome: string | null;
  outcome_note: string | null;
  closed_at: string | null;
  last_checked_at: string | null;
  readings_json: string;
}

/** A window as the store holds it: its readings, one row per offset, gathered
 * in offset order. */
async function storedWindow(id: string): Promise<StoredWindow> {
  const [row] = await pgRows<StoredWindow>(
    `SELECT w.status, w.outcome, w.outcome_note, w.closed_at, w.last_checked_at,
            coalesce((SELECT json_agg(json_build_object(
                        'offset_days', r.offset_days, 'check_date', r.check_date, 'checked_at', r.checked_at,
                        'final', r.final, 'baseline', r.baseline, 'post', r.post,
                        'delta_pct', r.delta_pct, 'pre_change_days', r.pre_change_days) ORDER BY r.offset_days)
                        FROM noticeos.watch_window_readings r WHERE r.window_id = w.window_id),
                     '[]'::json)::text AS readings_json
       FROM noticeos.watch_windows w WHERE w.window_id = $1`,
    [id],
  );
  expect(row).toBeDefined();
  return row!;
}

function readings(window: StoredWindow): WatchReading[] {
  return JSON.parse(window.readings_json) as WatchReading[];
}

type StoredFlag = {
  severity: string;
  kind: string;
  metric: string | null;
  message: string;
  rule_inputs: string;
};

/** Make the store refuse every closing window's flag, as the owner: a trigger
 * on the test's own copy. `asset` narrows it to one site. */
async function refuseWindowFlags(asset?: string): Promise<void> {
  await asOwner(`CREATE FUNCTION noticeos.refuse_window_flag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'window flag refused'; END $$;
CREATE TRIGGER refuse_window_flag BEFORE INSERT ON noticeos.flags FOR EACH ROW
  WHEN (NEW.rule_id = 'watch-window-closed'${asset === undefined ? '' : ` AND NEW.asset_id = '${asset}'`})
  EXECUTE FUNCTION noticeos.refuse_window_flag();`);
}

async function allowWindowFlags(): Promise<void> {
  await asOwner(`DROP TRIGGER refuse_window_flag ON noticeos.flags;
DROP FUNCTION noticeos.refuse_window_flag();`);
}

async function refusingWindowFlagsOn<T>(asset: string, run: () => Promise<T>): Promise<T> {
  await refuseWindowFlags(asset);
  try {
    return await run();
  } finally {
    await allowWindowFlags();
  }
}

/** A second open window, on northwind.example, whose final check is due. */
async function storeBrokenWindow(): Promise<void> {
  await inWorkspace(
    `INSERT INTO noticeos.watch_windows
       (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, registered_at,
        baseline_start, baseline_end, check_offsets)
     VALUES ($1::uuid, 'broken', 'northwind.example', 'manual', 'hand-edited',
             'gsc', 'clicks', $2::timestamptz, $3::date, $4::date, '{7}')`,
    [REGISTERED_AT, BASELINE_START, BASELINE_END],
  );
}

/** One statement as the application writes it, `$1` its workspace. */
async function inWorkspace(sql: string, params: SqlValue[]): Promise<void> {
  await env.STORE.write((tx) => tx.execute(sql, [tx.workspaceId, ...params]));
}

async function closedFlags(): Promise<StoredFlag[]> {
  return pgRows<StoredFlag>(
    `SELECT severity, kind, metric, message, rule_inputs::text AS rule_inputs
       FROM noticeos.current_flags WHERE rule_id = 'watch-window-closed' ORDER BY flag_number ASC`,
  );
}

describe('POST /api/watch-windows — registration', () => {
  it('rejects a request without the operator token (401)', async () => {
    const res = await call(watchRequest(registration()));
    expect(res.status).toBe(401);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.watch_windows`)).toBe(0);
  });

  it('registers a window, sorting the offsets and storing the predicate (201)', async () => {
    const res = await call(
      watchRequest(registration({ check_offsets: [7, 3] }), { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      created: boolean;
      watch_window: Record<string, unknown>;
    };
    expect(body.created).toBe(true);
    expect(body.watch_window).toMatchObject({
      asset: 'meadow.example',
      ref_kind: 'annotation',
      ref: '41',
      metric_integration: 'gsc',
      metric: 'clicks',
      registered_at: REGISTERED_AT,
      status: 'open',
      outcome: null,
      closed_at: null,
      scope_json: null,
      readings_json: '[]',
    });
    // The evaluator treats the largest offset as the final check, so the stored
    // order must not depend on how the operator typed them.
    expect(body.watch_window.check_offsets_json).toBe('[3,7]');
    expect(JSON.parse(String(body.watch_window.thresholds_json))).toMatchObject({
      ship: { direction: 'up', min_delta_pct: 10 },
    });
  });

  it('rejects an unknown asset (422)', async () => {
    const res = await call(
      watchRequest(registration({ asset: 'ghost.site' }), { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'unknown_asset' });
  });

  it('rejects a metric outside the integration vocabulary (422)', async () => {
    const res = await call(
      watchRequest(registration({ metric: 'sessions' }), { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues[0]).toMatchObject({ path: 'metric', code: 'invalid_value' });
    expect(body.issues[0]?.message).toContain('clicks');
  });

  it('rejects a baseline that runs past the registration date (422)', async () => {
    const res = await call(
      watchRequest(registration({ baseline_end: '2026-07-05' }), { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0]).toMatchObject({ path: 'baseline_end' });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.watch_windows`)).toBe(0);
  });

  // A final check sooner than the baseline is long would compare a post window
  // that reaches back over the change itself.
  it('rejects a final offset shorter than the baseline (422)', async () => {
    const res = await call(
      watchRequest(registration({ check_offsets: [3] }), { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues[0]).toMatchObject({ path: 'check_offsets' });
    expect(body.issues[0]?.message).toContain('7 days');
  });

  it('rejects a future registration (422)', async () => {
    const res = await call(
      watchRequest(
        registration({ registered_at: new Date(Date.now() + 86_400_000).toISOString() }),
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0]).toMatchObject({ path: 'registered_at' });
  });

  it('rejects a malformed threshold (422)', async () => {
    const res = await call(
      watchRequest(registration({ thresholds: { ship: { direction: 'sideways', min_delta_pct: 5 } } }), {
        token: OPERATOR_TOKEN,
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0]).toMatchObject({ path: 'thresholds.ship.direction' });
  });

  it('registers the same bet twice without holding two of them', async () => {
    // A spoke syncs its whole freeze register on every ship, so re-sending is
    // the normal case. The second POST answers 200 with the row it already had.
    const first = await call(
      watchRequest(registration({ readback_bead: 'md-w1n.2' }), { token: OPERATOR_TOKEN }),
    );
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ created: true, duplicate: false });

    const again = await call(
      watchRequest(registration({ readback_bead: 'md-w1n.2' }), { token: OPERATOR_TOKEN }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, duplicate: true });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.watch_windows`)).toBe(1);
  });

  // Postgres runs two writers side by side: the read and the insert hold the
  // bet, so a freeze register synced twice at once still holds the bet once.
  it('registers the same bet once when it arrives several times at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => writeWatchWindow(env, registration() as unknown as CreateWatchWindowInput)),
    );
    const ids = results.map((result) => (result.ok ? result.watchWindow.id : null));
    expect(new Set(ids)).toEqual(new Set([ids[0]]));
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.watch_windows`)).toBe(1);
  });

  it('reads a different scope as a different bet, because it is one', async () => {
    await register();
    await register({ scope: { query: 'high protein meal plan' } });
    await register({ scope: { page: '/meal-plans' } });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.watch_windows`)).toBe(3);
  });

  it('carries the bead that is owed the reading', async () => {
    const id = await register({ readback_bead: 'md-w1n.2' });
    const [row] = await pgRows<{ readback_bead: string; readback_posted_at: string | null }>(
      `SELECT readback_bead, readback_posted_at FROM noticeos.watch_windows WHERE window_id = $1`,
      [id],
    );
    expect(row).toEqual({ readback_bead: 'md-w1n.2', readback_posted_at: null });
  });

  it('refuses an average metric with no scope, and takes the same bet scoped', async () => {
    // Average position is taken over whatever the property appeared for, so a
    // property-wide window reads the query mix as much as the change.
    const wide = await call(
      watchRequest(
        registration({ metric: 'position', thresholds: {
        ship: { direction: 'down', min_delta_pct: 5 },
        kill: { direction: 'up', min_delta_pct: 5 },
      } }),
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(wide.status).toBe(422);
    const body = (await wide.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues.map((issue) => issue.path)).toContain('scope');
    // The field and what it needs, in one line.
    expect(body.issues.find((issue) => issue.path === 'scope')?.message).toBe('gsc/position needs one query or page');

    const scoped = await call(
      watchRequest(
        registration({
          metric: 'position',
          thresholds: {
        ship: { direction: 'down', min_delta_pct: 5 },
        kill: { direction: 'up', min_delta_pct: 5 },
      },
          scope: { query: 'high protein meal plan' },
        }),
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(scoped.status).toBe(201);
  });

  it('leaves a sum property-wide, because a total answers the same question', async () => {
    const res = await call(watchRequest(registration({ metric: 'clicks' }), { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(201);
  });

  it('registers a page scope and stores the selector verbatim', async () => {
    const id = await register({ scope: { page: '/meal-plans' } });
    const [row] = await pgRows<{ scope_json: string }>(
      `SELECT scope::text AS scope_json FROM noticeos.watch_windows WHERE window_id = $1`,
      [id],
    );
    expect(JSON.parse(String(row?.scope_json))).toEqual({ page: '/meal-plans' });
  });

  it('refuses a scope that names two selectors at once', async () => {
    const res = await call(
      watchRequest(
        registration({ scope: { query: 'high protein meal plan', page: '/meal-plans' } }),
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(422);
  });

  it('accepts a scope only where a daily archive backs it', async () => {
    const unknownSelector = await call(
      watchRequest(registration({ scope: { country: 'usa' } }), { token: OPERATOR_TOKEN }),
    );
    expect(unknownSelector.status).toBe(422);
    expect(await unknownSelector.json()).toMatchObject({
      issues: [{ path: 'scope', code: 'invalid_value' }],
    });

    // GA4 and Bing retain no daily archive at query or page grain, so a scope
    // there would be a question the evaluator cannot answer.
    const analytics = await call(
      watchRequest(
        registration({
          metric_integration: 'ga4',
          metric: 'sessions',
          scope: { query: 'high protein meal plan' },
        }),
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(analytics.status).toBe(422);
    expect(await analytics.json()).toMatchObject({
      issues: [{ path: 'scope', code: 'invalid_value' }],
    });
  });
});

// The Tower's door onto the same writer. The Tower is served unauthenticated
// on the LAN and must never hold the operator bearer, so it reaches this write
// over the private Service Binding — where the binding is the capability. The
// second door is not a softer one: the rules a curl hits are the rules the UI
// hits.
describe('createWatchWindow() — the Tower Service Binding', () => {
  it('registers without a bearer, because the binding IS the capability', async () => {
    const result = await worker().createWatchWindow({
      asset: 'meadow.example',
      ref_kind: 'annotation',
      ref: '41',
      metric_integration: 'gsc',
      metric: 'clicks',
      registered_at: REGISTERED_AT,
      baseline_start: BASELINE_START,
      baseline_end: BASELINE_END,
      check_offsets: [7, 3],
      thresholds: {
        ship: { direction: 'up', min_delta_pct: 10 },
        kill: { direction: 'down', min_delta_pct: 10 },
      },
      note: 'July title batch',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.watchWindow).toMatchObject({
      asset: 'meadow.example',
      ref_kind: 'annotation',
      ref: '41',
      metric_integration: 'gsc',
      metric: 'clicks',
      status: 'open',
      readings_json: '[]',
      note: 'July title batch',
    });
    // Same writer, so the same sorting: the evaluator reads the largest offset
    // as the final check.
    expect(result.watchWindow.check_offsets_json).toBe('[3,7]');
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.watch_windows`)).toBe(1);
  });

  it('refuses a baseline that overlaps the change, exactly as the bearer lane does', async () => {
    const result = await worker().createWatchWindow({
      ...(registration({ baseline_end: '2026-07-02' }) as unknown as Parameters<
        IngestWorker['createWatchWindow']
      >[0]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('validation');
    if (result.error !== 'validation') return;
    expect(result.issues[0]).toMatchObject({ path: 'baseline_end' });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.watch_windows`)).toBe(0);
  });

  it('answers an unknown asset as a result, never a thrown boundary error', async () => {
    const result = await worker().createWatchWindow(
      registration({ asset: 'ghost.site' }) as unknown as Parameters<
        IngestWorker['createWatchWindow']
      >[0],
    );

    expect(result).toMatchObject({ ok: false, error: 'unknown_asset', asset: 'ghost.site' });
  });

  it('offers the Tower exactly the series it can evaluate — no more, no fewer', () => {
    // `WATCH_SERIES` is what the Tower's chooser renders; `WATCH_METRICS` is
    // what the evaluator can read. A chooser one option short silently hides a
    // measurable question; one option long offers a check that 422s on submit.
    const evaluable = Object.entries(WATCH_METRICS)
      .flatMap(([integration, metrics]) =>
        Object.keys(metrics).map((metric) => `${integration}:${metric}`),
      )
      .sort();
    const offered = WATCH_SERIES.map(
      (series) => `${series.integration}:${series.metric}`,
    ).sort();
    expect(offered).toEqual(evaluable);

    // And they must agree on how each series collapses: `aggregation` decides
    // whether a series may be registered property-wide at all, so a contract
    // that called `position` a sum would let an average be bet on property-wide.
    for (const series of WATCH_SERIES) {
      expect(series.aggregation).toBe(WATCH_METRICS[series.integration][series.metric]);
    }
  });

  it('will not let an average be bet on property-wide', () => {
    // The rule in one line: bet property-wide on sums, bet scoped on averages.
    const scoped = WATCH_SERIES.filter(watchScopeRequired).map(
      (series) => `${series.integration}:${series.metric}`,
    );
    expect(scoped).toEqual(['gsc:ctr', 'gsc:position']);
  });

  it('agrees with the contract about how full a window has to be to be judged', () => {
    // The Tower calibrates a registration's threshold from this property's own
    // history and has to skip exactly the stretches this evaluator would close
    // `unmeasurable`, or the noise floor it reports is measured over
    // comparisons that never happen. The constant is stated once in the
    // contract; this pins the evaluator's own copy to it.
    expect(MIN_WINDOW_COVERAGE).toBe(WATCH_MIN_WINDOW_COVERAGE);
  });

  it('knows that a better search position is a SMALLER number', () => {
    // The one series where the obvious default is wrong: a composer that
    // pre-registered `ship: up` on average position would fire its "it worked"
    // predicate when the property got worse.
    const position = WATCH_SERIES.find((series) => series.metric === 'position');
    expect(position?.improvesWhen).toBe('down');
    for (const series of WATCH_SERIES.filter((s) => s.metric !== 'position')) {
      expect(series.improvesWhen).toBe('up');
    }
  });
});

describe('watch-window evaluation — readings', () => {
  it('records an interim reading and leaves the window open', async () => {
    await observeClicks(10, 13);
    const id = await register();

    const result = await runWatchWindows(env, INTERIM_RUN_MS);
    expect(result).toMatchObject({ scanned: 1, evaluated: 1, readings: 1 });
    expect(result.closed).toHaveLength(0);

    const stored = await storedWindow(id);
    expect(stored.status).toBe('open');
    expect(stored.outcome).toBeNull();
    expect(stored.last_checked_at).not.toBeNull();

    const [interim] = readings(stored);
    expect(interim).toMatchObject({
      offset_days: 3,
      check_date: '2026-07-04',
      final: false,
      delta_pct: 12.86,
    });
    expect(interim?.baseline).toMatchObject({ days: 7, per_day: 10, total: 70 });
    // +3 is shorter than the seven-day baseline, so this reading's post window
    // necessarily reaches back over the change. It is a reading, not a verdict.
    expect(interim?.pre_change_days).toBe(4);
    expect(await closedFlags()).toHaveLength(0);
  });

  it('leaves an offset that is not due yet alone', async () => {
    await observeClicks(10, 13);
    const id = await register();

    const result = await runWatchWindows(env, Date.parse('2026-07-02T03:30:00.000Z'));
    expect(result).toMatchObject({ scanned: 1, evaluated: 0, readings: 0 });
    expect(readings(await storedWindow(id))).toHaveLength(0);
  });

  it('does not re-evaluate an offset it has already read', async () => {
    await observeClicks(10, 13);
    const id = await register();

    await runWatchWindows(env, INTERIM_RUN_MS);
    const second = await runWatchWindows(env, INTERIM_RUN_MS);
    expect(second).toMatchObject({ evaluated: 0, readings: 0 });
    expect(readings(await storedWindow(id))).toHaveLength(1);
  });
});

describe('watch-window evaluation — outcomes', () => {
  it('closes ship_confirmed and files an info/opportunity flag carrying the numbers', async () => {
    await observeClicks(10, 13);
    const id = await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0]).toMatchObject({ asset: 'meadow.example', outcome: 'ship_confirmed' });

    const stored = await storedWindow(id);
    expect(stored).toMatchObject({ status: 'closed', outcome: 'ship_confirmed' });
    expect(stored.closed_at).not.toBeNull();
    const final = readings(stored).at(-1);
    expect(final).toMatchObject({ offset_days: 7, final: true, delta_pct: 30, pre_change_days: 0 });
    expect(final?.post).toMatchObject({ start: '2026-07-02', end: '2026-07-08', days: 7, per_day: 13 });

    const flags = await closedFlags();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: 'info', kind: 'opportunity', metric: 'clicks' });
    expect(flags[0]?.message).toContain('ship_confirmed');
    expect(flags[0]?.message).toContain('+30%');
    const inputs = JSON.parse(String(flags[0]?.rule_inputs)) as Record<string, unknown>;
    expect(inputs).toMatchObject({
      watchWindowId: id,
      integration: 'gsc',
      metric: 'clicks',
      outcome: 'ship_confirmed',
      ref: '41',
    });
    expect((inputs.reading as WatchReading).baseline?.per_day).toBe(10);
  });

  // The second verdict a property ever reaches: the dedupe guard only compares
  // once some row matches asset and rule_id, so the first close on a property
  // never exercises it.
  it('files a verdict for a property that already has one on file', async () => {
    await observeClicks(10, 13);
    await insertFlag({
      asset: 'meadow.example',
      firedAt: '2026-07-05T03:30:00.000Z',
      severity: 'info',
      kind: 'opportunity',
      metric: 'clicks',
      message: 'watch window ship_confirmed — an earlier bet',
      ruleId: 'watch-window-closed',
      ruleInputs: JSON.stringify({ rule: 'watch-window-closed', watchWindowId: crypto.randomUUID() }),
    });
    const id = await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.failed).toEqual([]);
    expect((await storedWindow(id)).status).toBe('closed');
    expect(await closedFlags()).toHaveLength(2);
  });

  // One transaction: the close, the readings it took, then the flag. The store
  // refuses the flag, the last write: the close and the readings before it are
  // undone with it, so the window is still open and unread, and the next sweep
  // closes it and files its verdict once.
  it('undoes the close when its flag is refused, and closes it with one flag on the next sweep', async () => {
    await observeClicks(10, 13);
    const id = await register();
    await refuseWindowFlags();
    try {
      const refused = await runWatchWindows(env, FINAL_RUN_MS);
      expect(refused.failed).toEqual([{ id, error: expect.stringContaining('window flag refused') }]);
      expect(refused.closed).toEqual([]);
      const stored = await storedWindow(id);
      expect(stored).toMatchObject({ status: 'open', outcome: null, closed_at: null, last_checked_at: null });
      expect(readings(stored)).toEqual([]);
      expect(await closedFlags()).toHaveLength(0);
    } finally {
      await allowWindowFlags();
    }

    const retried = await runWatchWindows(env, FINAL_RUN_MS + 60_000);
    expect(retried.failed).toEqual([]);
    expect(retried.closed.map((closed) => closed.id)).toEqual([id]);
    const stored = await storedWindow(id);
    expect(stored.status).toBe('closed');
    expect(readings(stored).map((reading) => reading.offset_days)).toEqual([3, 7]);
    expect(await closedFlags()).toHaveLength(1);
  });

  it('closes kill_confirmed at warn severity', async () => {
    await observeClicks(10, 7);
    await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'kill_confirmed' });
    const flags = await closedFlags();
    expect(flags[0]).toMatchObject({ severity: 'warn', kind: 'anomaly' });
    expect(flags[0]?.message).toContain('-30%');
  });

  it('closes inconclusive when the movement meets neither threshold', async () => {
    await observeClicks(10, 10.2);
    await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'inconclusive' });
    expect(result.closed[0]?.note).toContain('+2%');
    expect((await closedFlags())[0]).toMatchObject({ severity: 'info', kind: 'anomaly' });
  });

  it('closes inconclusive when the ship and the kill predicate both match', async () => {
    await observeClicks(10, 13);
    await register({
      thresholds: {
        ship: { direction: 'up', min_delta_pct: 10 },
        kill: { direction: 'up', min_delta_pct: 20 },
      },
    });

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'inconclusive' });
    expect(result.closed[0]?.note).toContain('ship and kill thresholds both match');
    expect((await closedFlags())[0]).toMatchObject({ severity: 'info', kind: 'anomaly' });
  });

  it('files one verdict when two sweeps close the same window', async () => {
    await observeClicks(10, 13);
    const id = await register();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let readOpen!: () => void;
    const lateReadOpen = new Promise<void>((resolve) => { readOpen = resolve; });
    // The late sweep reads the window open, then waits to write until the
    // other sweep has closed it.
    const slowStore = new Proxy(env.STORE, {
      get(target, property) {
        if (property === 'read') {
          return async (work: Parameters<typeof target.read>[0]) => {
            const rows = await target.read(work);
            readOpen();
            return rows;
          };
        }
        if (property === 'write') {
          return async (work: Parameters<typeof target.write>[0]) => {
            await held;
            return target.write(work);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const late = runWatchWindows(Object.assign({}, env, { STORE: slowStore }), FINAL_RUN_MS);
    await lateReadOpen;
    const first = await runWatchWindows(env, FINAL_RUN_MS);
    release();
    const second = await late;

    expect(first.closed.map((closed) => closed.id)).toEqual([id]);
    expect(second.failed).toEqual([]);
    const stored = await storedWindow(id);
    expect(stored).toMatchObject({ status: 'closed', outcome: 'ship_confirmed' });
    expect(readings(stored).map((reading) => reading.offset_days)).toEqual([3, 7]);
    expect(await closedFlags()).toHaveLength(1);
  });

  // The system may not invent a verdict it was never given.
  it('closes inconclusive with the numbers when no threshold was registered', async () => {
    await observeClicks(10, 13);
    await register({ thresholds: null });

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'inconclusive' });
    expect(result.closed[0]?.note).toContain('no ship/kill threshold was registered');
    expect(result.closed[0]?.note).toContain('+30%');
  });

  it('closes a query-scoped window on its own archived daily series', async () => {
    // The site fell while this query rose. A site-wide fallback would call this
    // a loss; the scoped archive must call the query's +30% win.
    await observeClicks(20, 5);
    await archiveQueryClicks(10, 13);
    const id = await register({ scope: { query: 'high protein meal plan' } });

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'ship_confirmed' });
    // The evaluator's figures and nothing else: the series, scope and offset
    // are the row's own title on the Activity tab.
    expect(result.closed[0]?.note).toBe('13/day vs baseline 10/day (+30%)');
    // The flag is read without its row, so its statistics line still says
    // which series, which scope and which check.
    expect((await closedFlags())[0]?.message).toBe(
      'watch window ship_confirmed — gsc/clicks for query “high protein meal plan” at +7d: ' +
        '13/day vs baseline 10/day (+30%)',
    );

    const stored = await storedWindow(id);
    expect(stored.status).toBe('closed');
    expect(stored.outcome_note).toBe('13/day vs baseline 10/day (+30%)');
    expect(readings(stored).at(-1)?.baseline).toMatchObject({ days: 7, per_day: 10 });
    expect(readings(stored).at(-1)?.post).toMatchObject({ days: 7, per_day: 13 });
    const inputs = JSON.parse(String((await closedFlags())[0]?.rule_inputs)) as {
      scoped: boolean;
      scope: { query: string };
    };
    expect(inputs.scoped).toBe(true);
    expect(inputs.scope).toEqual({ query: 'high protein meal plan' });
  });

  it('closes a page-scoped window on that page\'s own archived series', async () => {
    // The site-wide series says the opposite, and must not be consulted: every
    // property-wide day here is flat while the page itself is up 30%.
    await observeClicks(10, 10);
    await archivePageClicks(10, 13);
    const id = await register({ scope: { page: '/meal-plans' } });

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ id, outcome: 'ship_confirmed' });
    expect(result.closed[0]?.note).toBe('13/day vs baseline 10/day (+30%)');
    expect((await closedFlags())[0]?.message).toContain('gsc/clicks for page /meal-plans at +7d: ');
    expect(readings(await storedWindow(id)).at(-1)?.post).toMatchObject({ days: 7, per_day: 13 });
  });

  it('matches a route against the archive\'s absolute URLs, host and slash included', async () => {
    await archivePageClicks(10, 13);
    // 2026-06-25 is archived as https://www.meadow.example/meal-plans/ — one
    // property, the hosts and trailing slashes a domain property really mixes.
    const aggregate = await aggregateScopedMetric(
      env,
      'meadow.example',
      'clicks',
      { kind: 'page', value: '/meal-plans' },
      BASELINE_START,
      BASELINE_END,
    );
    expect(aggregate).toMatchObject({ days: 7, per_day: 10 });
  });

  it('never substitutes the property total for a page with no rows', async () => {
    await observeClicks(10, 13);
    await archivePageClicks(10, 13);
    await register({ scope: { page: '/a-page-that-never-shipped' } });

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'unmeasurable' });
  });

  it('calibrates from the evaluator\'s same dense query series without filling absences', async () => {
    await archiveQueryDay('2026-06-24', [
      { query: '  High   Protein Meal Plan ', clicks: 10 },
    ]);
    await archiveQueryDay('2026-06-25', [
      { query: 'another query', clicks: 999 },
    ]);
    await archiveQueryDay('2026-06-26', [
      { query: 'high protein meal plan', clicks: 13 },
    ]);
    await insertAnnotation({
      asset: 'meadow.example',
      at: '2026-06-25T18:00:00.000Z',
      kind: 'deploy',
      ref: 'fixture',
      note: 'changed',
    });

    const history = await readWatchQueryHistory(env, {
      asset: 'meadow.example',
      metric: 'clicks',
      query: 'High Protein Meal Plan',
      first_day: '2026-06-24',
      last_day: '2026-06-28',
    });
    expect(history).toMatchObject({
      query: 'High Protein Meal Plan',
      archiveFirstDay: '2026-06-24',
      archiveLastDay: '2026-06-26',
      archiveDays: 3,
      observedDays: 2,
      recordedChanges: {
        firstDay: '2026-06-24',
        lastDay: '2026-06-28',
        days: ['2026-06-25'],
        complete: true,
      },
    });
    expect(history.values).toEqual([10, null, 13, null, null]);

    const aggregate = await aggregateScopedMetric(
      env,
      'meadow.example',
      'clicks',
      { kind: 'query', value: 'High Protein Meal Plan' },
      '2026-06-24',
      '2026-06-28',
    );
    expect(aggregate).toMatchObject({ days: 2, span_days: 5, per_day: 11.5 });
  });

  it('closes an unsupported stored scope unmeasurable without a site fallback', async () => {
    await observeClicks(10, 13);
    const id = await register({ scope: { query: 'high protein meal plan' } });
    // Simulate a legacy/hand-edited row the stricter registration boundary
    // cannot create now; a registration is fixed, so only the owner edits it.
    await asOwner(`UPDATE noticeos.watch_windows SET scope = '{"country":"usa"}' WHERE window_id = '${id}';`);

    const result = await runWatchWindows(env, INTERIM_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'unmeasurable' });
    expect(result.closed[0]?.note).toBe('stored scope unsupported · no site-wide fallback');
    expect(readings(await storedWindow(id))).toHaveLength(0);
  });

  it('closes unmeasurable when the series has no observations at all', async () => {
    await register();
    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'unmeasurable' });
    expect(result.closed[0]?.note).toContain('baseline');
  });

  // "We could not measure this" and "we measured it and it did nothing" are
  // different facts; thin coverage must never collapse into inconclusive.
  it('closes unmeasurable when the post window is mostly holes', async () => {
    const values: Record<string, number> = {};
    for (const date of dateRange(BASELINE_START, '2026-07-01')) values[date] = 10;
    values['2026-07-07'] = 13;
    values['2026-07-08'] = 13;
    await observe('meadow.example', 'gsc', 'clicks', values);
    await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'unmeasurable' });
    expect(result.closed[0]?.note).toContain('thin coverage');
    expect(result.closed[0]?.note).toContain('2/7');
  });

  it('records the interim readings it caught up on before closing', async () => {
    await observeClicks(10, 13);
    const id = await register();

    // Both offsets come due before the evaluator's first run.
    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result).toMatchObject({ evaluated: 1, readings: 1 });
    const stored = await storedWindow(id);
    expect(readings(stored).map((reading) => reading.offset_days)).toEqual([3, 7]);
    expect(readings(stored).map((reading) => reading.final)).toEqual([false, true]);
  });

  it('leaves a closed window alone on later runs', async () => {
    await observeClicks(10, 13);
    const id = await register();

    await runWatchWindows(env, FINAL_RUN_MS);
    const closed = await storedWindow(id);

    const second = await runWatchWindows(env, FINAL_RUN_MS + 3 * DAY_MS);
    expect(second).toMatchObject({ scanned: 0, evaluated: 0, readings: 0, closed: [] });
    expect(await storedWindow(id)).toEqual(closed);
    expect(await closedFlags()).toHaveLength(1);
  });

  it('reads the latest revision of a provider-revised date', async () => {
    await observeClicks(10, 13);
    // A later successful run revises the final post day downward hard enough to
    // pull the whole window under the ship threshold.
    await observe(
      'meadow.example',
      'gsc',
      'clicks',
      { '2026-07-08': 0 },
      '2026-07-08T03:00:00.000Z',
    );
    await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    const stored = await storedWindow(result.closed[0]!.id);
    expect(readings(stored).at(-1)?.post).toMatchObject({ days: 7, per_day: 11.1429 });
    expect(result.closed[0]).toMatchObject({ outcome: 'ship_confirmed' });
  });

  // A window whose evaluation throws must not cost the other windows their
  // check. The store refuses one registered_at that is not an instant, so the
  // throw is the store refusing the broken window's close.
  it('isolates a window whose own evaluation throws', async () => {
    await observeClicks(10, 13);
    const healthy = await register();
    await storeBrokenWindow();

    const result = await refusingWindowFlagsOn('northwind.example', () => runWatchWindows(env, FINAL_RUN_MS));
    expect(result.failed.map((entry) => entry.id)).toEqual(['broken']);
    expect(result.closed).toHaveLength(1);
    expect((await storedWindow(healthy)).outcome).toBe('ship_confirmed');
  });

  it('evaluates one asset per window, independently', async () => {
    await observeClicks(10, 13);
    const values: Record<string, number> = {};
    for (const date of dateRange(BASELINE_START, '2026-07-08')) {
      values[date] = date <= '2026-07-01' ? 20 : 12;
    }
    await observe('northwind.example', 'gsc', 'clicks', values);
    await register();
    await register({ asset: 'northwind.example' });

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.scanned).toBe(2);
    expect(
      Object.fromEntries(result.closed.map((entry) => [entry.asset, entry.outcome])),
    ).toEqual({ 'meadow.example': 'ship_confirmed', 'northwind.example': 'kill_confirmed' });
    expect(await closedFlags()).toHaveLength(2);
  });
});

// A comparison is only honest inside one measurement series. An asset
// repointed at another GSC site or GA4 property is measuring a different
// resource, and the evaluator must refuse to subtract one from the other.
describe('watch-window evaluation — one provider resource per comparison', () => {
  const OLD_SITE = 'sc-domain:meadow.example';
  const NEW_SITE = 'https://meadow.example/';

  /** Clicks written through the real change-only writer, not a fixture insert. */
  async function collect(
    propertyRef: string,
    window: { start: string; end: string },
    value: (date: string) => number,
    credentialRef = 'test-account',
  ): Promise<void> {
    const dates = dateRange(window.start, window.end);
    await recordSignalSuccess(
      env,
      { asset: 'meadow.example', integration: 'gsc', credentialRef, propertyRef },
      window,
      new Date().toISOString(),
      {
        providerRows: dates.length,
        observations: dates.map((date) => ({ date, metric: 'clicks', value: value(date) })),
        dataState: 'final',
        provisionalFrom: null,
        timeZone: 'America/Los_Angeles',
      },
    );
  }

  it('closes unmeasurable when the post window was measured on a different property', async () => {
    // Equal values on purpose: suppressed as "unchanged" against the old
    // site's 10s, the post window would silently read the old site and close
    // as a like-for-like 0%.
    await collect(OLD_SITE, { start: BASELINE_START, end: '2026-07-08' }, () => 10);
    await collect(NEW_SITE, { start: '2026-07-02', end: '2026-07-08' }, () => 10);
    const id = await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ id, outcome: 'unmeasurable' });
    expect(result.closed[0]?.note).toContain(`"${OLD_SITE}"`);
    expect(result.closed[0]?.note).toContain(`"${NEW_SITE}"`);
    expect(result.closed[0]?.note).toBe(`baseline on "${OLD_SITE}", post window on "${NEW_SITE}"`);

    const final = readings(await storedWindow(id)).at(-1);
    expect(final?.baseline?.properties).toEqual([OLD_SITE]);
    expect(final?.post?.properties).toEqual([NEW_SITE]);
    expect((await closedFlags())[0]?.message).toContain('unmeasurable');
  });

  it('closes unmeasurable when one window\'s own days span a property switch', async () => {
    await observe('meadow.example', 'gsc', 'clicks',
      Object.fromEntries(dateRange(BASELINE_START, '2026-07-08').map((date) => [date, 10])),
      '2026-07-05T02:45:00.000Z', { propertyRef: OLD_SITE });
    // The new site only ever reported the last four post days.
    await observe('meadow.example', 'gsc', 'clicks',
      Object.fromEntries(dateRange('2026-07-05', '2026-07-08').map((date) => [date, 13])),
      '2026-07-08T02:45:00.000Z', { propertyRef: NEW_SITE });
    await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ outcome: 'unmeasurable' });
    expect(result.closed[0]?.note).toContain('post window spans properties');
    expect(result.closed[0]?.note).toContain(`"${OLD_SITE}"`);
    expect(result.closed[0]?.note).toContain(`"${NEW_SITE}"`);
  });

  it('compares a new property on itself once it has re-reported both windows', async () => {
    // A switched-to property's first run covers the provider's whole horizon, so
    // both windows are read from it alone: one series, a fair comparison.
    await collect(OLD_SITE, { start: BASELINE_START, end: '2026-07-08' }, () => 20);
    await collect(NEW_SITE, { start: BASELINE_START, end: '2026-07-08' },
      (date) => (date <= '2026-07-01' ? 10 : 13));
    const id = await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ id, outcome: 'ship_confirmed' });
    const final = readings(await storedWindow(id)).at(-1);
    expect(final?.baseline).toMatchObject({ per_day: 10, properties: [NEW_SITE] });
    expect(final?.post).toMatchObject({ per_day: 13, properties: [NEW_SITE] });
  });

  it('evaluates normally across a credential rotation on the same property', async () => {
    await collect(OLD_SITE, { start: BASELINE_START, end: '2026-07-01' }, () => 10, 'account-a');
    await collect(OLD_SITE, { start: BASELINE_START, end: '2026-07-08' },
      (date) => (date <= '2026-07-01' ? 10 : 13), 'account-b');
    const id = await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ id, outcome: 'ship_confirmed' });
    const final = readings(await storedWindow(id)).at(-1);
    expect(final?.baseline).toMatchObject({ days: 7, per_day: 10, properties: [OLD_SITE] });
    expect(final?.post).toMatchObject({ days: 7, per_day: 13, properties: [OLD_SITE] });
    // The rotated run re-recorded nothing it had not changed.
    expect(
      await storedCount(
        `SELECT count(*)::int AS n FROM noticeos.signal_observations o
           JOIN noticeos.signal_runs r ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
          WHERE r.credential_ref = 'account-b'`,
      ),
    ).toBe(7);
  });

  it('aggregates a zero day as a measured zero, not a hole', async () => {
    await collect(OLD_SITE, { start: BASELINE_START, end: '2026-07-08' },
      (date) => (date <= '2026-07-01' ? 10 : 0));
    const id = await register();

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result.closed[0]).toMatchObject({ id, outcome: 'kill_confirmed' });
    const final = readings(await storedWindow(id)).at(-1);
    expect(final?.post).toMatchObject({ days: 7, total: 0, per_day: 0 });
  });
});

describe("watch-window evaluation — the sweep's own report", () => {
  it('names the window that threw, because the dispatch table reads no result', async () => {
    await observeClicks(10, 13);
    await register();
    await storeBrokenWindow();

    const event = watchSweepEvent(
      await refusingWindowFlagsOn('northwind.example', () => runWatchWindows(env, FINAL_RUN_MS)),
    );
    expect(event).toMatchObject({ event: 'watch_windows_complete', scanned: 2, evaluated: 2 });
    expect(event.errors.map((entry) => entry.id)).toEqual(['broken']);
    expect(event.closed[0]?.outcome).toBe('ship_confirmed');
    // The window that threw is past its final check and unanswered, so it is
    // overdue as well.
    expect(event.overdue).toEqual(['broken']);
  });

  it('reports a bet left unanswered past its final check, even with nothing thrown', async () => {
    // The failure `failed` cannot see: every offset already read, the close
    // never applied, so the sweep finds nothing due and reports a clean run over
    // a window whose verdict is a fortnight late.
    await observeClicks(10, 13);
    await inWorkspace(
      `INSERT INTO noticeos.watch_windows
         (workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, registered_at,
          baseline_start, baseline_end, check_offsets)
       VALUES ($1::uuid, 'stalled', 'meadow.example', 'annotation', '41',
               'gsc', 'clicks', $2::timestamptz, $3::date, $4::date, '{3,7}')`,
      [REGISTERED_AT, BASELINE_START, BASELINE_END],
    );
    for (const [offset, day, final] of [[3, '2026-07-04', false], [7, '2026-07-08', true]] as const) {
      await inWorkspace(
        `INSERT INTO noticeos.watch_window_readings
           (workspace_id, window_id, offset_days, check_date, checked_at, final, pre_change_days)
         VALUES ($1::uuid, 'stalled', $2, $3::date, $4::timestamptz, $5, 0)`,
        [offset, day, `${day}T03:30:00.000Z`, final],
      );
    }

    const result = await runWatchWindows(env, FINAL_RUN_MS);
    expect(result).toMatchObject({ scanned: 1, evaluated: 0, failed: [] });
    expect(result.overdue).toEqual(['stalled']);
    expect(watchSweepEvent(result).overdue).toEqual(['stalled']);
  });

  it('leaves a window whose final check has not come due out of the overdue list', async () => {
    await observeClicks(10, 13);
    await register();

    const result = await runWatchWindows(env, INTERIM_RUN_MS);
    expect(result).toMatchObject({ evaluated: 1, readings: 1, closed: [], overdue: [] });
  });
});

