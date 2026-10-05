// A SAVED MAPPING REACHES THE NEXT COLLECTOR RUN (beads `ro-7xv2`, `ro-syok.7`).
//
// This is the bead's whole claim, driven end to end in one isolate: an operator
// changes which Bing site an asset maps to, nothing restarts, and the very next
// cron fire asks the provider for the site they saved. Everything in between is
// the real path — `applyConfigOps` is the door the Sources tab's Save goes
// through, `runCron` is the function both the platform's `scheduled()` and the
// local runner's RPC call, and the collector is the one that talks to Bing.
//
// WHY BING IS THE LANE UNDER TEST. It is the cheapest mapped lane to drive
// honestly: one API key, one site list, and the site it asks for is a string
// this suite can read straight off the request. GA4 and Search Console resolve
// the same mapping through the same resolver on the same read, so a second
// signed-in fixture would prove the same seam twice.
//
// THE FIRST RUN IS HALF THE PROOF. Before anything is seeded the same fire reads
// the copy compiled into this Worker and matches the asset's own domain — which
// is what makes "applying the migration changes nothing on its own" (D22) a
// tested claim rather than a promise.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The compiled copy this Worker falls back to is, in this suite, the frozen
// test/fixture-config/ document, never the checkout's own (bead ro-ujb9.92).
import integrationsJson from './fixture-config/integrations.json';
import { applyConfigOps, forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { PULL_CRON } from '../src/crons.js';
import { runCron } from '../src/dispatch.js';
import { reset, emptyTables } from './helpers.js';

const NOW = Date.parse('2026-09-05T09:00:00.000Z');
const DOMAIN_MATCHED = 'https://meals.example/';
const SEEDED = 'https://seeded.meals.example/';
const SAVED = 'https://www.meals.example/';

/**
 * Every seeded property, as Bing spells its verified sites — and NOTHING the
 * register points at.
 *
 * That is the point of the fixture: a mapped asset asks for the site the
 * register names whether or not this list agrees, which is the whole reason
 * Bing has a mapping field (one account can hold two sites that share a host).
 * So the site a run asked for says unambiguously which of the two answered.
 */
const SITES = [
  'https://meals.example/',
  'https://nosh.example/',
  'https://pacer.example/',
  'https://pullups.example/',
  'https://areas.example/',
  'https://fees.example/',
];

/**
 * The whole run's outbound traffic.
 *
 * Bing answers; everything else — the nightly pull's own two self-report
 * endpoints — is refused with a 503, which that lane records as a failed pull
 * and never as an unreachable uplink (a refusal carries a status; only a
 * connection with none is the OS's own outage). So this fire exercises the
 * mapping without inventing a working property endpoint.
 */
function stubOutbound(): { sitesAsked: string[] } {
  const sitesAsked: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const url = new URL(href);
    if (url.hostname !== 'ssl.bing.com') {
      return new Response('unavailable', { status: 503 });
    }
    if (url.pathname.endsWith('/GetUserSites')) {
      return Response.json({ d: SITES.map((Url) => ({ Url })) });
    }
    sitesAsked.push(url.searchParams.get('siteUrl') ?? '');
    return Response.json({ d: [] });
  }) as typeof fetch;
  vi.stubGlobal('fetch', impl);
  return { sitesAsked };
}

/** The `bing_signals_complete` line this fire wrote, parsed. */
function completionLine(logged: string[]): Record<string, unknown> {
  const line = logged
    .map((text) => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.event === 'bing_signals_complete');
  expect(line, 'the run wrote no completion line').not.toBeUndefined();
  return line as Record<string, unknown>;
}

/** `config/integrations.json` as the suite's frozen copy holds it, with one
 * Bing site already mapped — the state `pnpm config:seed` leaves behind. */
function seedableIntegrations(): Record<string, unknown> {
  const document = structuredClone(integrationsJson) as unknown as {
    assets: Record<string, Record<string, Record<string, unknown>>>;
  };
  document.assets['meals.example']!['bing-webmaster']!.siteUrl = SEEDED;
  return document as unknown as Record<string, unknown>;
}

describe('a saved mapping reaches the collectors without a restart', () => {
  let logged: string[];

  beforeEach(async () => {
    await reset();
    await emptyTables(['config_documents']);
    await emptyTables(['config_changes']);
    forgetConfigCache();
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs on the compiled copy while nothing is seeded, and says so', async () => {
    const { sitesAsked } = stubOutbound();
    await runCron(PULL_CRON, env);

    expect(sitesAsked).toContain(DOMAIN_MATCHED);
    expect(sitesAsked).not.toContain(SEEDED);
    expect(completionLine(logged).configSource).toEqual({
      'config/integrations.json': 'file',
    });
  });

  it('asks for the site the Save wrote, on the next run, with no restart', async () => {
    await seedConfigDocuments(
      env,
      { documents: { 'config/integrations.json': seedableIntegrations() }, actor: 'config:seed' },
      NOW,
    );

    const before = stubOutbound();
    await runCron(PULL_CRON, env);
    expect(before.sitesAsked).toContain(SEEDED);
    expect(completionLine(logged).configSource).toEqual({
      'config/integrations.json': 'store',
    });

    // THE SAVE. Exactly the op the Sources tab builds for this field — one
    // `file-json-set` at the pointer the `asset-lane` declaration licenses,
    // guarded by the value the browser rendered.
    const saved = await applyConfigOps(
      env,
      {
        ops: [
          {
            kind: 'file-json-set',
            file: 'config/integrations.json',
            pointer: '/assets/meals.example/bing-webmaster/siteUrl',
            expect: SEEDED,
            value: SAVED,
          },
        ],
        actor: 'operator',
        slug: 'meals-bing-site',
      },
      NOW + 1000,
    );
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    // NOTHING RESTARTS AND NOTHING IS FLUSHED BY HAND between the Save and the
    // run: `applyConfigOps` forgets the read cache itself, which is what makes
    // "the next run" true for the isolate that took the Save and for one that
    // did not.
    logged = [];
    const after = stubOutbound();
    await runCron(PULL_CRON, env);

    expect(after.sitesAsked).toContain(SAVED);
    expect(after.sitesAsked).not.toContain(SEEDED);
    expect(completionLine(logged).configSource).toEqual({
      'config/integrations.json': 'store',
    });
  });
});
