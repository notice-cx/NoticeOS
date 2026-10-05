import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PANEL_SOURCE_DEFAULT_WINDOW_DAYS,
  PANEL_SOURCE_MAX_WINDOW_DAYS,
  panelSourceCutoff,
  panelSourceWindowDays,
} from '../src/panel-source.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call, reset, storeArchiveRun, storeSignalRun } from './helpers.js';

beforeEach(reset);

interface SourceBody {
  asset: string;
  from: string;
  windowDays: number;
  manifest: {
    integration: string;
    report: string;
    reportDate: string;
    finishedAt: string;
    objectKey: string;
    contentSha256: string;
    providerRows: number;
    providerTruncated: number;
  }[];
  trend: {
    date: string;
    integration: string;
    metric: string;
    value: number;
    provisional: number;
  }[];
}

function today(offsetDays = 0): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

interface SeedArchiveRow {
  asset: string;
  integration: string;
  report: string;
  reportDate: string;
  finishedAt: string;
  status: string;
  objectKey: string;
  contentSha256: string;
  providerRows: number;
  providerTruncated: number;
}

/** One archive manifest row, as the collectors write them. */
async function seedArchive(
  overrides: Partial<SeedArchiveRow> = {},
): Promise<{ objectKey: string }> {
  const row: SeedArchiveRow = {
    asset: 'nosh.example',
    integration: 'gsc',
    report: 'query',
    reportDate: today(1),
    finishedAt: `${today(1)}T12:15:00.000Z`,
    status: 'success',
    objectKey: `signals/nosh.example/${crypto.randomUUID()}.json.gz`,
    contentSha256: 'a'.repeat(64),
    providerRows: 31,
    providerTruncated: 0,
    ...overrides,
  };
  await storeArchiveRun({
    id: crypto.randomUUID(), asset: row.asset, integration: row.integration, report: row.report,
    credential_ref: 'test-cred', property_ref: 'example.test', report_date: row.reportDate, finished_at: row.finishedAt,
    status: row.status as 'success' | 'unchanged' | 'error', data_state: 'provider-final', provider_rows: row.providerRows,
    request_count: 1, provider_truncated: row.providerTruncated === 1, object_key: row.objectKey,
    content_sha256: row.contentSha256, object_bytes: 2048, error_code: 'provider_error', error_message: 'the provider refused',
  });
  return { objectKey: row.objectKey };
}

/** One normalized daily series run plus its observations. */
async function seedObservations(input: {
  asset?: string;
  integration?: string;
  finishedAt?: string;
  status?: string;
  provisionalFrom?: string | null;
  /** The provider resource measured (a GSC site, a GA4 property). */
  propertyRef?: string;
  credentialRef?: string;
  rows: { date: string; metric: string; value: number }[];
}): Promise<void> {
  const asset = input.asset ?? 'nosh.example';
  const integration = input.integration ?? 'gsc';
  const finishedAt = input.finishedAt ?? `${today(0)}T00:15:00.000Z`;
  const status = input.status ?? 'success';
  const provisionalFrom = input.provisionalFrom ?? null;
  const failed = status === 'error';
  // On Postgres (bead ro-ujb9.76.5.3). A failed run carries no values: the
  // store refuses a value under a run that did not succeed.
  await storeSignalRun(
    {
      id: crypto.randomUUID(),
      asset,
      integration,
      credential_ref: input.credentialRef ?? 'test-cred',
      property_ref: input.propertyRef ?? 'example.test',
      finished_at: finishedAt,
      status: failed ? 'error' : 'success',
      window_start: '2026-05-01',
      window_end: today(0),
      data_state: provisionalFrom === null ? 'final' : 'includes-provisional',
      provisional_from: provisionalFrom,
      provider_rows: input.rows.length,
      observation_count: input.rows.length,
      error_code: failed ? 'provider_error' : null,
      error_message: failed ? 'the provider refused' : null,
    },
    failed ? [] : input.rows,
  );
}

function sourceRequest(query: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://ingest.local/api/panel-source${query}`, {
    method: 'GET',
    headers,
  });
}

async function source(
  query = '?asset=nosh.example',
  token: string | undefined = OPERATOR_TOKEN,
): Promise<SourceBody> {
  const res = await call(sourceRequest(query, token));
  expect(res.status).toBe(200);
  return (await res.json()) as SourceBody;
}

describe('GET /api/panel-source — auth and arguments', () => {
  it('rejects a request without the operator token (401)', async () => {
    expect((await call(sourceRequest('?asset=nosh.example'))).status).toBe(401);
  });

  it('rejects a wrong operator token (401)', async () => {
    expect((await call(sourceRequest('?asset=nosh.example', 'nope'))).status).toBe(401);
  });

  it('refuses a missing or malformed asset (400)', async () => {
    expect((await call(sourceRequest('', OPERATOR_TOKEN))).status).toBe(400);
    expect((await call(sourceRequest('?asset=NOT VALID', OPERATOR_TOKEN))).status).toBe(400);
  });

  // The window is a performance bound, not a correctness one, so a nonsense
  // value must not stop the nightly refresh — it falls back to the default.
  it('clamps the window rather than failing on a bad one', () => {
    expect(panelSourceWindowDays(null)).toBe(PANEL_SOURCE_DEFAULT_WINDOW_DAYS);
    expect(panelSourceWindowDays('')).toBe(PANEL_SOURCE_DEFAULT_WINDOW_DAYS);
    expect(panelSourceWindowDays('banana')).toBe(PANEL_SOURCE_DEFAULT_WINDOW_DAYS);
    expect(panelSourceWindowDays('0')).toBe(PANEL_SOURCE_DEFAULT_WINDOW_DAYS);
    expect(panelSourceWindowDays('7')).toBe(7);
    expect(panelSourceWindowDays('99999')).toBe(PANEL_SOURCE_MAX_WINDOW_DAYS);
  });

  it('reports the window it actually used', async () => {
    const body = await source('?asset=nosh.example&windowDays=7');
    expect(body.windowDays).toBe(7);
    expect(body.from).toBe(panelSourceCutoff(Date.now(), 7));
  });
});

describe('GET /api/panel-source — the archive manifest', () => {
  it('lists what the refresh has to put on disk', async () => {
    const { objectKey } = await seedArchive();
    const body = await source();
    expect(body.manifest).toEqual([
      {
        integration: 'gsc',
        report: 'query',
        reportDate: today(1),
        finishedAt: `${today(1)}T12:15:00.000Z`,
        objectKey,
        contentSha256: 'a'.repeat(64),
        providerRows: 31,
        providerTruncated: 0,
      },
    ]);
  });

  // The collector re-archives a day inside its revision window. Two revisions of
  // one day on disk would double-count it in every flattened CSV.
  it('keeps only the newest revision of a report day', async () => {
    await seedArchive({
      objectKey: 'signals/nosh.example/old.json.gz',
      finishedAt: `${today(1)}T12:15:00.000Z`,
      providerRows: 10,
    });
    await seedArchive({
      objectKey: 'signals/nosh.example/new.json.gz',
      finishedAt: `${today(1)}T18:15:00.000Z`,
      providerRows: 12,
    });
    const body = await source();
    expect(body.manifest.map((row) => row.objectKey)).toEqual(['signals/nosh.example/new.json.gz']);
  });

  // An `unchanged` re-fetch means the bytes already stored are current, and the
  // manifest still points at them.
  it('counts an unchanged re-fetch as an archive', async () => {
    await seedArchive({ status: 'unchanged' });
    expect((await source()).manifest).toHaveLength(1);
  });

  it('ignores a failed collection — there is no object to fetch', async () => {
    await seedArchive({ status: 'error' });
    expect((await source()).manifest).toEqual([]);
  });

  it('ignores another property’s archive', async () => {
    await seedArchive({ asset: 'meals.example' });
    expect((await source()).manifest).toEqual([]);
  });

  it('drops a report day older than the window', async () => {
    await seedArchive({ reportDate: today(90), finishedAt: `${today(90)}T12:15:00.000Z` });
    expect((await source('?asset=nosh.example&windowDays=7')).manifest).toEqual([]);
  });
});

describe('GET /api/panel-source — the daily trend', () => {
  it('returns the normalized daily series the per-report CSVs cannot sum', async () => {
    await seedObservations({
      rows: [
        { date: today(2), metric: 'clicks', value: 12 },
        { date: today(2), metric: 'impressions', value: 340 },
      ],
    });
    const body = await source();
    expect(body.trend).toEqual([
      { date: today(2), integration: 'gsc', metric: 'clicks', value: 12, provisional: 0 },
      { date: today(2), integration: 'gsc', metric: 'impressions', value: 340, provisional: 0 },
    ]);
  });

  // A later run that re-reported an earlier date is the provider revising it.
  it('takes the newest run’s value for a date it re-reported', async () => {
    await seedObservations({
      finishedAt: `${today(1)}T00:15:00.000Z`,
      rows: [{ date: today(2), metric: 'clicks', value: 9 }],
    });
    await seedObservations({
      finishedAt: `${today(0)}T00:15:00.000Z`,
      rows: [{ date: today(2), metric: 'clicks', value: 14 }],
    });
    expect((await source()).trend.map((row) => row.value)).toEqual([14]);
  });

  // Provisional days are carried, not dropped: a reader who cannot see that the
  // last day is still filling in reads it as a cliff.
  it('marks a day the provider had not finished reporting', async () => {
    await seedObservations({
      provisionalFrom: today(0),
      rows: [
        { date: today(1), metric: 'clicks', value: 20 },
        { date: today(0), metric: 'clicks', value: 3 },
      ],
    });
    const body = await source();
    expect(body.trend.map((row) => [row.date, row.provisional])).toEqual([
      [today(1), 0],
      [today(0), 1],
    ]);
  });

  it('keeps each integration’s series separate', async () => {
    await seedObservations({ integration: 'gsc', rows: [{ date: today(1), metric: 'clicks', value: 5 }] });
    await seedObservations({
      integration: 'bing-webmaster',
      rows: [{ date: today(1), metric: 'clicks', value: 2 }],
    });
    const body = await source();
    expect(body.trend.map((row) => [row.integration, row.value])).toEqual([
      ['bing-webmaster', 2],
      ['gsc', 5],
    ]);
  });

  it('ignores a failed run and another property’s series', async () => {
    await seedObservations({ status: 'error', rows: [{ date: today(1), metric: 'clicks', value: 99 }] });
    await seedObservations({ asset: 'meals.example', rows: [{ date: today(1), metric: 'clicks', value: 77 }] });
    expect((await source()).trend).toEqual([]);
  });

  it('drops a date older than the window', async () => {
    await seedObservations({ rows: [{ date: today(90), metric: 'clicks', value: 1 }] });
    expect((await source('?asset=nosh.example&windowDays=7')).trend).toEqual([]);
  });

  // Repointing the asset at another Search Console site starts a different
  // series (ro-ujb9.70). A day only the old site reported is that site's number
  // and must not be spliced in front of the new site's.
  it('reads only the current provider resource after a property switch', async () => {
    await seedObservations({
      propertyRef: 'sc-domain:nosh.example',
      finishedAt: `${today(1)}T00:15:00.000Z`,
      rows: [
        { date: today(3), metric: 'clicks', value: 7 },
        { date: today(2), metric: 'clicks', value: 8 },
      ],
    });
    await seedObservations({
      propertyRef: 'https://nosh.example/',
      finishedAt: `${today(0)}T00:15:00.000Z`,
      rows: [{ date: today(2), metric: 'clicks', value: 5 }],
    });
    expect((await source()).trend.map((row) => [row.date, row.value])).toEqual([[today(2), 5]]);
  });

  it('keeps the whole series across a credential rotation on the same resource', async () => {
    await seedObservations({
      credentialRef: 'old-key',
      finishedAt: `${today(1)}T00:15:00.000Z`,
      rows: [{ date: today(3), metric: 'clicks', value: 7 }],
    });
    await seedObservations({
      credentialRef: 'new-key',
      finishedAt: `${today(0)}T00:15:00.000Z`,
      rows: [{ date: today(2), metric: 'clicks', value: 5 }],
    });
    expect((await source()).trend.map((row) => [row.date, row.value])).toEqual([
      [today(3), 7],
      [today(2), 5],
    ]);
  });
});

describe('GET /api/signal-archives — the hand downloader’s manifest', () => {
  interface ArchivesBody {
    asset: string;
    filters: { from: string | null; to: string | null; integration: string | null; report: string | null };
    manifest: { integration: string; report: string; reportDate: string; objectKey: string }[];
  }

  function archivesRequest(query: string, token?: string): Request {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return new Request(`https://ingest.local/api/signal-archives${query}`, {
      method: 'GET',
      headers,
    });
  }

  async function archives(query = '?asset=nosh.example'): Promise<ArchivesBody> {
    const res = await call(archivesRequest(query, OPERATOR_TOKEN));
    expect(res.status).toBe(200);
    return (await res.json()) as ArchivesBody;
  }

  it('rejects a request without the operator token (401)', async () => {
    expect((await call(archivesRequest('?asset=nosh.example'))).status).toBe(401);
  });

  it('refuses a missing or malformed asset (400)', async () => {
    expect((await call(archivesRequest('', OPERATOR_TOKEN))).status).toBe(400);
    expect((await call(archivesRequest('?asset=NOT VALID', OPERATOR_TOKEN))).status).toBe(400);
  });

  // An operator who mistyped --from must not be handed a wider answer than they
  // asked for and left to notice.
  it('refuses a malformed filter rather than ignoring it (400)', async () => {
    for (const query of [
      '?asset=nosh.example&from=last-week',
      '?asset=nosh.example&to=2026-8-1',
      '?asset=nosh.example&integration=GA4',
      '?asset=nosh.example&report=page_query',
    ]) {
      const res = await call(archivesRequest(query, OPERATOR_TOKEN));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_filter');
    }
  });

  // `pnpm signals:download -- --asset x` means every report day this store has
  // ever archived. A window applied on the caller's behalf would silently drop
  // the history they asked for.
  it('reaches history no panel window would', async () => {
    await seedArchive({ reportDate: today(400), finishedAt: `${today(400)}T12:15:00.000Z` });
    const body = await archives();
    expect(body.manifest).toHaveLength(1);
    expect(body.filters).toEqual({ from: null, to: null, integration: null, report: null });
  });

  it('narrows to the report days between --from and --to', async () => {
    await seedArchive({ reportDate: '2026-07-01', finishedAt: '2026-07-02T12:15:00.000Z' });
    await seedArchive({ reportDate: '2026-07-15', finishedAt: '2026-07-16T12:15:00.000Z' });
    await seedArchive({ reportDate: '2026-08-01', finishedAt: '2026-08-02T12:15:00.000Z' });
    const body = await archives('?asset=nosh.example&from=2026-07-10&to=2026-07-31');
    expect(body.manifest.map((row) => row.reportDate)).toEqual(['2026-07-15']);
    expect(body.filters.from).toBe('2026-07-10');
  });

  it('narrows to one integration and one report family', async () => {
    await seedArchive({ integration: 'gsc', report: 'query' });
    await seedArchive({ integration: 'gsc', report: 'page-query' });
    await seedArchive({ integration: 'ga4', report: 'events' });
    expect(
      (await archives('?asset=nosh.example&integration=gsc')).manifest.map((row) => row.report).sort(),
    ).toEqual(['page-query', 'query']);
    expect(
      (await archives('?asset=nosh.example&integration=gsc&report=query')).manifest.map(
        (row) => row.report,
      ),
    ).toEqual(['query']);
  });

  // Same resolver as the panel refresh reads through: two revisions of one day
  // on disk would double-count it in every flattened CSV.
  it('keeps only the newest revision of a report day', async () => {
    await seedArchive({ objectKey: 'signals/nosh.example/old.json.gz', finishedAt: `${today(1)}T12:15:00.000Z` });
    await seedArchive({ objectKey: 'signals/nosh.example/new.json.gz', finishedAt: `${today(1)}T18:15:00.000Z` });
    expect((await archives()).manifest.map((row) => row.objectKey)).toEqual([
      'signals/nosh.example/new.json.gz',
    ]);
  });

  it('ignores a failed collection and another property’s archive', async () => {
    await seedArchive({ status: 'error' });
    await seedArchive({ asset: 'meals.example' });
    expect((await archives()).manifest).toEqual([]);
  });
});

describe('GET /api/panel-object', () => {
  const archive = { schemaVersion: 1, asset: 'nosh.example', pages: [{ rows: [1, 2, 3] }] };

  async function putArchive(key: string): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(archive));
    const gz = new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
    );
    await env.RAW_SIGNALS.put(key, await gz.arrayBuffer(), {
      httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    });
  }

  function objectRequest(query: string, token?: string): Request {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return new Request(`https://ingest.local/api/panel-object${query}`, {
      method: 'GET',
      headers,
    });
  }

  it('rejects a request without the operator token (401)', async () => {
    expect((await call(objectRequest('?key=whatever'))).status).toBe(401);
  });

  it('refuses a missing key (400)', async () => {
    expect((await call(objectRequest('', OPERATOR_TOKEN))).status).toBe(400);
  });

  it('returns the archive decompressed, ready to write to disk', async () => {
    const { objectKey } = await seedArchive();
    await putArchive(objectKey);
    const res = await call(objectRequest(`?key=${encodeURIComponent(objectKey)}`, OPERATOR_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(archive);
  });

  // The manifest membership check IS the authorization beyond the bearer: this
  // route serves archives the OS collected, never anything else in the bucket.
  it('refuses a key no manifest row claims (404)', async () => {
    await putArchive('signals/loose/object.json.gz');
    const res = await call(
      objectRequest('?key=signals%2Floose%2Fobject.json.gz', OPERATOR_TOKEN),
    );
    expect(res.status).toBe(404);
  });

  // An empty file would flatten to a CSV that reads as a real zero, so a
  // manifest row whose object is gone must fail loudly instead.
  it('refuses a manifest row whose object is missing (404)', async () => {
    const { objectKey } = await seedArchive();
    const res = await call(objectRequest(`?key=${encodeURIComponent(objectKey)}`, OPERATOR_TOKEN));
    expect(res.status).toBe(404);
  });
});
