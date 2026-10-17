// Read again on a site's Settings tab runs the daily job's icons step now for
// that one site: the same read, egress gate and store write, refused while the
// job is paused and for any site the daily read does not cover, and recorded
// as a manual run of its job.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import constantsJson from './fixture-config/constants.json';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { runSiteIconsNow } from '../src/dispatch.js';
import { emptyTables, pgRows, reset, storedCount } from './helpers.js';
import { changeSites } from './sites';

const NOW = Date.parse('2026-10-17T15:00:00.000Z');

const HEAD = `<head>
<link rel="icon" href="/brand/icon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/brand/icon-32-dark.png" sizes="32x32" type="image/png" media="(prefers-color-scheme: dark)">
</head>`;

/** One site answering its home page; every other address is refused. */
function site(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const handler = routes[url];
    if (!handler) throw new Error(`connection refused: ${url}`);
    return handler();
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const meadowHome = () => site({
  'https://meadow.example/': () => new Response(HEAD, { status: 200, headers: { 'content-type': 'text/html' } }),
});

async function pauseHygiene(): Promise<void> {
  const constants = structuredClone(constantsJson) as Record<string, unknown>;
  constants.schedules = { hygiene: { enabled: false, cron: '0 4 * * *' } };
  const seeded = await seedConfigDocuments(env, { documents: { 'config/constants.json': constants }, actor: 'config:seed' }, NOW);
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
}

describe('Read again reads one site now, through the daily read', () => {
  beforeEach(async () => {
    await reset();
    await emptyTables(['config_documents']);
    forgetConfigCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores the read for that site alone and answers it, recorded as a manual run of its job', async () => {
    const { fetchImpl, asked } = meadowHome();

    const result = await runSiteIconsNow(env, { asset: 'meadow.example' }, { fetchImpl, nowMs: NOW });

    expect(result).toEqual({
      ok: true,
      asset: 'meadow.example',
      readAt: new Date(NOW).toISOString(),
      outcome: 'read',
      light: 'https://meadow.example/brand/icon-32.png',
      dark: 'https://meadow.example/brand/icon-32-dark.png',
    });
    expect(asked).toEqual(['https://meadow.example/']);
    expect(await pgRows<{ asset: string; outcome: string }>(
      `SELECT asset_id AS asset, outcome FROM noticeos.asset_icons ORDER BY asset_id`,
    )).toEqual([{ asset: 'meadow.example', outcome: 'read' }]);
    expect(await pgRows<{ job: string; outcome: string }>(
      `SELECT job, outcome FROM noticeos.job_runs WHERE detail = 'trigger:manual'`,
    )).toEqual([{ job: 'cron 0 4 * * *', outcome: 'ran' }]);
  });

  it('refuses while the daily job is paused, asking no page and storing nothing', async () => {
    await pauseHygiene();
    const { fetchImpl, asked } = meadowHome();

    const result = await runSiteIconsNow(env, { asset: 'meadow.example' }, { fetchImpl, nowMs: NOW });

    expect(result).toEqual({ ok: false, asset: 'meadow.example', error: 'paused' });
    expect(asked).toEqual([]);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.asset_icons`)).toBe(0);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.job_runs`)).toBe(0);
  });

  it('refuses a site the daily read does not cover: retired, the System or unknown', async () => {
    await changeSites(['puffin.example'], { status: 'retired' });
    try {
      const { fetchImpl, asked } = site({});
      for (const asset of ['puffin.example', 'root-os', 'ghost.example']) {
        expect(await runSiteIconsNow(env, { asset }, { fetchImpl, nowMs: NOW })).toEqual({ ok: false, asset, error: 'no-site' });
      }
      expect(asked).toEqual([]);
      expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.job_runs`)).toBe(0);
    } finally {
      await changeSites(['puffin.example'], { status: 'onboarding' });
    }
  });
});
