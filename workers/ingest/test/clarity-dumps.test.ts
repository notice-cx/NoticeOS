import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { clarityVerdict, runClarityDumps } from '../src/clarity-dumps.js';
import { putCredential } from '../src/credentials.js';
import { ARCHIVE_RUNS, credentialVerdict, pgCount, pgFirst, reset } from './helpers.js';

const NOW = Date.parse('2026-07-31T04:30:00.000Z');
const TOKEN = 'clarity-project-token';

/** The provider's real response shape: several metric blocks over one dimension
 * split, each with its own field set. */
function clarityBody(urlRows = 2) {
  const urls = Array.from({ length: urlRows }, (_, i) => `https://meals.example/p${i}`);
  return [
    {
      metricName: 'DeadClickCount',
      information: urls.map((Url) => ({
        sessionsCount: '114',
        sessionsWithMetricPercentage: 11.4,
        pagesViews: '14',
        subTotal: '19',
        Url,
      })),
    },
    {
      metricName: 'ScrollDepth',
      information: urls.map((Url) => ({ averageScrollDepth: 67.78, Url })),
    },
    {
      // The unattributed aggregate really does come back with a null Url.
      metricName: 'Traffic',
      information: [
        {
          totalSessionCount: '0',
          totalBotSessionCount: '1',
          distinctUserCount: '245',
          Url: null,
        },
      ],
    },
  ];
}

interface Fixture {
  fetchImpl: typeof fetch;
  calls: { url: string; authorization: string | null }[];
}

function clarityFetch(
  responder: (url: URL) => Response = () => Response.json(clarityBody()),
): Fixture {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url: href, authorization: headers.get('authorization') });
    return responder(new URL(href));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(reset);

describe('Microsoft Clarity export lane', () => {
  it('spends one daily call per configured project and archives it verbatim', async () => {
    const { fetchImpl, calls } = clarityFetch();
    const result = await runClarityDumps(env, {
      nowMs: NOW,
      fetchImpl,
      rawTokens: JSON.stringify({ 'meals.example': TOKEN }),
    });

    // One property configured; every other launched property is skipped
    // silently rather than failed.
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.skipped).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);

    const requested = new URL(calls[0]!.url);
    expect(requested.origin + requested.pathname).toBe(
      'https://www.clarity.ms/export-data/api/v1/project-live-insights',
    );
    expect(requested.searchParams.get('numOfDays')).toBe('3');
    expect(requested.searchParams.get('dimension1')).toBe('URL');
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN}`);

    const manifest = await pgFirst<{
      report: string;
      status: string;
      dataState: string;
      providerRows: number;
      providerTruncated: number;
      credentialRef: string;
      objectKey: string;
    }>(`SELECT report, status, data_state AS "dataState", provider_rows AS "providerRows",
              provider_truncated AS "providerTruncated", credential_ref AS "credentialRef",
              object_key AS "objectKey"
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'clarity'`);
    expect(manifest).toMatchObject({
      report: 'url-3d',
      status: 'success',
      dataState: 'provider-snapshot',
      // 2 + 2 dimension rows + 1 unattributed Traffic row.
      providerRows: 5,
      providerTruncated: 0,
    });
    // The SLOT is recorded, never the token.
    expect(manifest?.credentialRef).toBe('CLARITY_TOKENS');

    const object = await env.RAW_SIGNALS.get(manifest!.objectKey);
    const archivedText = await new Response(
      object!.body.pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(manifest!.objectKey).toContain('raw/microsoft/clarity/');
    expect(archivedText).not.toContain(TOKEN);
    const archived = JSON.parse(archivedText) as {
      integration: string;
      pages: { request: Record<string, unknown>; response: unknown }[];
    };
    expect(archived.integration).toBe('clarity');
    expect(archived.pages[0]?.request).toMatchObject({
      numOfDays: 3,
      dimension1: 'URL',
    });
  });

  it('runs on the credential entered in the product, and leaves its verdict on the card', async () => {
    // Bead `ro-vu8d.9`: Clarity is the first per-asset credential, and the one
    // whose card has NO probe of its own — its export allows ten calls a day,
    // so a Test button that called Clarity would spend one. This run is
    // therefore the only thing that can ever prove those tokens work, which is
    // why it stamps the credential.
    await putCredential(env, {
      provider: 'clarity',
      fields: { CLARITY_TOKENS: JSON.stringify({ 'meals.example': TOKEN }) },
    });
    const { fetchImpl, calls } = clarityFetch();
    // No `rawTokens`: the resolver has to find the map in the store on its own.
    const result = await runClarityDumps(env, { nowMs: NOW, fetchImpl });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN}`);

    // "still on .dev.vars" is a fact you read rather than assume.
    const ref = await pgFirst<{ credentialRef: string }>(`SELECT credential_ref AS "credentialRef" FROM ${ARCHIVE_RUNS} WHERE integration = 'clarity'`);
    expect(ref?.credentialRef).toBe('store:CLARITY_TOKENS');

    const stamped = await credentialVerdict('clarity');
    expect(stamped?.lastOkAt).toBe(new Date(NOW).toISOString());
    expect(stamped?.lastError).toBeNull();
  });

  it('tells the card what failed and for which site, in the site row’s words (ro-ujb9.96.6.31)', async () => {
    await putCredential(env, {
      provider: 'clarity',
      fields: { CLARITY_TOKENS: JSON.stringify({ 'meals.example': TOKEN }) },
    });
    const { fetchImpl } = clarityFetch(() =>
      Response.json({ message: 'Unauthorized' }, { status: 401 }),
    );
    const result = await runClarityDumps(env, { nowMs: NOW, fetchImpl });
    expect(result).toMatchObject({ attempted: 1, failed: 1 });

    const stamped = await credentialVerdict('clarity');
    expect(stamped?.lastOkAt).toBeNull();
    // The card says what the site's own row says, then the site: no code, and
    // never the token.
    expect(stamped?.lastError).toBe('Access was refused · meals.example');
    expect(stamped?.lastError).not.toContain(TOKEN);
  });

  it('words each failure kind once, and counts the sites past three', () => {
    expect(clarityVerdict([{ asset: 'a.example', errorCode: 'clarity_daily_cap_reached' }])).toBe(
      'The daily request allowance is exhausted · a.example',
    );
    expect(
      clarityVerdict([
        { asset: 'a.example', errorCode: 'clarity_token_rejected' },
        { asset: 'b.example', errorCode: 'clarity_http_500' },
        { asset: 'c.example', errorCode: 'clarity_token_rejected' },
      ]),
    ).toBe('Access was refused · The provider could not complete the request · a.example, b.example, c.example');
    expect(
      clarityVerdict(
        ['a', 'b', 'c', 'd'].map((name) => ({ asset: `${name}.example`, errorCode: 'clarity_token_rejected' })),
      ),
    ).toBe('Access was refused · 4 sites');
  });

  it('skips a property with no token silently — no call, no manifest row', async () => {
    const { fetchImpl, calls } = clarityFetch();
    const result = await runClarityDumps(env, { nowMs: NOW, fetchImpl, rawTokens: '' });

    expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
    expect(result.skipped).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    // An unconfigured lane must not manufacture a daily error storm.
    expect(
      await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'clarity'`),
    ).toBe(0);
  });

  it('names the older single-asset binding on the manifest row it answered for', async () => {
    // Bead `ro-vu8d.24`: the single-project binding is folded into the asset map
    // by `resolveCredential`, so this lane reads ONE map — but the manifest must
    // still record which slot actually held the token, or "is this asset still
    // on the old binding" stops being a fact you can read.
    const { fetchImpl, calls } = clarityFetch();
    const result = await runClarityDumps(env, {
      nowMs: NOW,
      fetchImpl,
      rawTokens: JSON.stringify({ 'meals.example': 'single-project-token' }),
      legacySlots: { 'meals.example': 'CLARITY_PROJECT_API_TOKEN' },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(calls[0]!.authorization).toBe('Bearer single-project-token');
    const ref = await pgFirst<{ credentialRef: string }>(`SELECT credential_ref AS "credentialRef" FROM ${ARCHIVE_RUNS} WHERE integration = 'clarity'`);
    expect(ref?.credentialRef).toBe('CLARITY_PROJECT_API_TOKEN');
  });

  it('separates a rejected token from an exhausted daily cap', async () => {
    const rejected = clarityFetch(() =>
      Response.json({ message: 'Unauthorized' }, { status: 401 }),
    );
    const tokenResult = await runClarityDumps(env, {
      nowMs: NOW,
      fetchImpl: rejected.fetchImpl,
      rawTokens: JSON.stringify({ 'meals.example': TOKEN }),
    });
    expect(tokenResult.outcomes[0]).toMatchObject({
      status: 'error',
      errorCode: 'clarity_token_rejected',
      objectKey: null,
    });

    await reset();
    const capped = clarityFetch(() =>
      Response.json({ message: 'Too many requests' }, { status: 429 }),
    );
    const capResult = await runClarityDumps(env, {
      nowMs: NOW,
      fetchImpl: capped.fetchImpl,
      rawTokens: JSON.stringify({ 'meals.example': TOKEN }),
    });
    // The two need different operator actions, so they must not share a code.
    expect(capResult.outcomes[0]).toMatchObject({
      status: 'error',
      errorCode: 'clarity_daily_cap_reached',
    });
  });

  it('records an empty body as a failed observation, not a property with no behavior', async () => {
    const { fetchImpl } = clarityFetch(() => Response.json([]));
    const result = await runClarityDumps(env, {
      nowMs: NOW,
      fetchImpl,
      rawTokens: JSON.stringify({ 'meals.example': TOKEN }),
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(result.outcomes[0]).toMatchObject({
      errorCode: 'clarity_invalid_response',
      providerRows: 0,
    });
  });

  it('marks a block sitting on the provider row cap as truncated', async () => {
    const { fetchImpl } = clarityFetch(() => Response.json(clarityBody(1000)));
    const result = await runClarityDumps(env, {
      nowMs: NOW,
      fetchImpl,
      rawTokens: JSON.stringify({ 'meals.example': TOKEN }),
    });

    // There is no pagination past 1,000 rows, so the count is a floor.
    expect(result.outcomes[0]).toMatchObject({
      status: 'success',
      providerTruncated: true,
    });
  });
});
