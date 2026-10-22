// The daily icon read: what a home page's head declares, which icon is kept
// for light and for dark surfaces, and what one read stores. Head fragments
// are real ones, under example domains.

import { env } from 'cloudflare:test';
import { javascriptInstant, type Transaction, type WorkspaceStore } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { EGRESS_BEACONS, EGRESS_DOWN_RULE_ID } from '../src/egress.js';
import {
  SITE_ICONS_USER_AGENT,
  chooseSiteIcons,
  iconScheme,
  largestSize,
  parseDeclaredIcons,
  runSiteIcons,
  type SiteIconTarget,
} from '../src/site-icons.js';
import { flagRows, pgRows, reset } from './helpers.js';
import { changeSites } from './sites';

beforeEach(reset);

const NOW = Date.parse('2026-07-20T04:00:00.000Z');

// --- head fragments -----------------------------------------------------------

/** A site's real head: a light 32 px PNG, two dark PNGs and an apple-touch-icon. */
const LIGHT_AND_DARK_PNGS = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Example</title>
<link rel="icon" href="/brand/icon-32.png" sizes="32x32" type="image/png"/>
<link rel="icon" href="/brand/icon-32-dark.png" sizes="32x32" type="image/png" media="(prefers-color-scheme: dark)"/>
<link rel="icon" href="/brand/icon-16-dark.png" sizes="16x16" type="image/png" media="(prefers-color-scheme: dark)"/>
<link rel="apple-touch-icon" href="/brand/icon-180.png"/>
</head><body><h1>Example</h1></body></html>`;

/** A site that declares only its `/favicon.ico`. */
const FAVICON_ONLY = `<html><head><title>Old asset</title>
<link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">
<link rel="stylesheet" href="/style.css">
</head><body></body></html>`;

/** An SVG icon beside the multi-size `.ico`, a dark PNG and an apple-touch-icon. */
const SVG_AND_DARK_PNG = `<head>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/icon-dark-64.png" sizes="64x64" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#000000">
</head>`;

/** Relative addresses: against the page, against the root, and scheme-relative. */
const RELATIVE_HREFS = `<head>
<link rel=icon href="icons/fav-48.png" sizes=48x48>
<link rel="icon" href="//cdn.example.net/dark.svg" media="(prefers-color-scheme:dark)">
</head>`;

/** A `<base href>` every relative address resolves against. */
const BASE_HREF = `<head>
<base href="https://cdn.example.net/static/">
<link rel="icon" href="favicon-48.png" sizes="48x48">
</head>`;

describe('the icons a head declares', () => {
  it('keeps the 32 px light icon and the 32 px dark one from a real head', () => {
    expect(chooseSiteIcons(LIGHT_AND_DARK_PNGS, 'https://www.example.com/')).toEqual({
      light: 'https://www.example.com/brand/icon-32.png',
      dark: 'https://www.example.com/brand/icon-32-dark.png',
    });
    expect(parseDeclaredIcons(LIGHT_AND_DARK_PNGS).icons.map((icon) => [icon.kind, icon.href, iconScheme(icon.media)])).toEqual([
      ['icon', '/brand/icon-32.png', 'light'],
      ['icon', '/brand/icon-32-dark.png', 'dark'],
      ['icon', '/brand/icon-16-dark.png', 'dark'],
      ['apple-touch-icon', '/brand/icon-180.png', 'light'],
    ]);
  });

  it('keeps a declared /favicon.ico for light surfaces and has no dark icon', () => {
    expect(chooseSiteIcons(FAVICON_ONLY, 'https://example.com/')).toEqual({
      light: 'https://example.com/favicon.ico',
      dark: null,
    });
  });

  it('prefers the SVG for light surfaces and keeps the dark PNG, ignoring the Safari mask icon', () => {
    expect(chooseSiteIcons(SVG_AND_DARK_PNG, 'https://example.org/')).toEqual({
      light: 'https://example.org/icon.svg',
      dark: 'https://example.org/icon-dark-64.png',
    });
  });

  it('resolves relative and scheme-relative addresses against the page read', () => {
    expect(chooseSiteIcons(RELATIVE_HREFS, 'https://example.com/blog/')).toEqual({
      light: 'https://example.com/blog/icons/fav-48.png',
      dark: 'https://cdn.example.net/dark.svg',
    });
  });

  it('resolves against a <base href> when the head has one', () => {
    expect(parseDeclaredIcons(BASE_HREF).base).toBe('https://cdn.example.net/static/');
    expect(chooseSiteIcons(BASE_HREF, 'https://example.com/')).toEqual({
      light: 'https://cdn.example.net/static/favicon-48.png',
      dark: null,
    });
  });

  it('declares nothing when the head has no icon link', () => {
    expect(chooseSiteIcons('<head><title>t</title><link rel="canonical" href="/"></head>', 'https://example.com/')).toEqual({
      light: null,
      dark: null,
    });
  });

  it('ranks SVG, then a raster of 32 px or more, then an unsized raster, then an apple-touch-icon, then a small raster', () => {
    const pick = (links: string) => chooseSiteIcons(`<head>${links}</head>`, 'https://example.com/').light;
    const svg = '<link rel="icon" href="/a.svg">';
    const big = '<link rel="icon" href="/b-64.png" sizes="64x64">';
    const mid = '<link rel="icon" href="/c-32.png" sizes="16x16 32x32">';
    const unsized = '<link rel="icon" href="/d.ico">';
    const touch = '<link rel="apple-touch-icon" href="/e-180.png" sizes="180x180">';
    const small = '<link rel="icon" href="/f-16.png" sizes="16x16">';
    expect(pick(small + touch + unsized + mid + big + svg)).toBe('https://example.com/a.svg');
    expect(pick(small + touch + unsized + mid + big)).toBe('https://example.com/b-64.png');
    expect(pick(small + touch + unsized + mid)).toBe('https://example.com/c-32.png');
    expect(pick(small + touch + unsized)).toBe('https://example.com/d.ico');
    expect(pick(small + touch)).toBe('https://example.com/e-180.png');
    expect(pick(small)).toBe('https://example.com/f-16.png');
    // Two of one rank: the first declared.
    expect(pick('<link rel="icon" href="/one.png" sizes="32x32"><link rel="icon" href="/two.png" sizes="32x32">')).toBe(
      'https://example.com/one.png',
    );
  });

  it('reads only the head, and no link inside a comment, a script or a template', () => {
    const html = `<head>
<!-- <link rel="icon" href="/commented.svg"> -->
<script>document.write('<link rel="icon" href="/scripted.svg">')</script>
<template><link rel="icon" href="/templated.svg"></template>
<link rel="icon" href="/real.png" sizes="32x32">
</head><body><link rel="icon" href="/body.svg"></body>`;
    expect(chooseSiteIcons(html, 'https://example.com/').light).toBe('https://example.com/real.png');
  });

  it('decodes character references and skips an address that is not a web page', () => {
    const html = `<head>
<link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">
<link rel="icon" href="javascript:void(0)">
<link rel="icon" href="/icon.png?v=2&amp;size=32" sizes="32x32">
</head>`;
    expect(chooseSiteIcons(html, 'https://example.com/').light).toBe('https://example.com/icon.png?v=2&size=32');
  });

  it('calls a media query dark only when it asks for the dark scheme', () => {
    expect(iconScheme(null)).toBe('light');
    expect(iconScheme('(prefers-color-scheme: light)')).toBe('light');
    expect(iconScheme('(prefers-color-scheme:dark)')).toBe('dark');
    expect(iconScheme('screen and (PREFERS-COLOR-SCHEME: DARK)')).toBe('dark');
    expect(iconScheme('not all and (prefers-color-scheme: dark)')).toBe('light');
    expect(iconScheme('(max-width: 600px)')).toBe('light');
  });

  it('reads the largest edge a sizes attribute declares', () => {
    expect(largestSize('16x16 32x32 48X48')).toBe(48);
    expect(largestSize('any')).toBeNull();
    expect(largestSize(null)).toBeNull();
    expect(largestSize('120x60')).toBe(120);
  });
});

// --- the lane -----------------------------------------------------------------

interface StubCall {
  url: string;
  userAgent: string | null;
  cookie: string | null;
  redirect: RequestInit['redirect'];
}

/** Route url -> response; an unrouted url fails at the transport level. */
function stubOrigin(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, userAgent: headers.get('user-agent'), cookie: headers.get('cookie'), redirect: init?.redirect });
    const handler = routes[url];
    if (!handler) throw new Error(`connection refused: ${url}`);
    return handler();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string, status = 301): Response =>
  new Response(null, { status, headers: { location } });
/** Any beacon answering: the OS can get out, so a silent site is the site's. */
const EGRESS_UP: Record<string, () => Response> = { [EGRESS_BEACONS[0]]: () => new Response('ok') };

interface StoredRead {
  asset: string;
  read_at: string;
  outcome: string;
  light_url: string | null;
  dark_url: string | null;
  detail: Record<string, unknown>;
}

async function storedReads(): Promise<StoredRead[]> {
  const rows = await pgRows<Omit<StoredRead, 'detail'> & { detail: string }>(
    `SELECT asset_id AS asset, read_at, outcome, light_url, dark_url, detail::text AS detail
       FROM noticeos.asset_icons ORDER BY asset_id, read_at`,
  );
  return rows.map((row) => ({ ...row, read_at: javascriptInstant(row.read_at), detail: JSON.parse(row.detail) as Record<string, unknown> }));
}

const MEADOW: SiteIconTarget = { asset: 'meadow.example', domain: 'meadow.example' };
const NORTHWIND: SiteIconTarget = { asset: 'northwind.example', domain: 'northwind.example' };
const PEBBLE: SiteIconTarget = { asset: 'pebble.example', domain: 'pebble.example' };

describe('the daily icon read', () => {
  it('stores a read, a page with no icon and an unreachable page, one row each', async () => {
    const { fetchImpl, calls } = stubOrigin({
      ...EGRESS_UP,
      'https://meadow.example/': () => html(LIGHT_AND_DARK_PNGS),
      'https://northwind.example/': () => html('<html><head><title>No icon</title></head><body></body></html>'),
      'https://pebble.example/': () => new Response('down', { status: 503 }),
    });

    const result = await runSiteIcons(env, { fetchImpl, nowMs: NOW, assets: [MEADOW, NORTHWIND, PEBBLE] });

    expect(result).toMatchObject({ skipped: null, assets: 3, failed: [] });
    expect(result.reads).toEqual([
      {
        asset: 'meadow.example',
        outcome: 'read',
        light: 'https://meadow.example/brand/icon-32.png',
        dark: 'https://meadow.example/brand/icon-32-dark.png',
      },
      { asset: 'northwind.example', outcome: 'no-icon', light: null, dark: null },
      { asset: 'pebble.example', outcome: 'unreachable', light: null, dark: null },
    ]);
    const at = new Date(NOW).toISOString();
    expect(await storedReads()).toEqual([
      {
        asset: 'meadow.example',
        read_at: at,
        outcome: 'read',
        light_url: 'https://meadow.example/brand/icon-32.png',
        dark_url: 'https://meadow.example/brand/icon-32-dark.png',
        detail: { pageUrl: 'https://meadow.example/', status: 200 },
      },
      {
        asset: 'northwind.example',
        read_at: at,
        outcome: 'no-icon',
        light_url: null,
        dark_url: null,
        detail: { pageUrl: 'https://northwind.example/', status: 200 },
      },
      {
        asset: 'pebble.example',
        read_at: at,
        outcome: 'unreachable',
        light_url: null,
        dark_url: null,
        detail: { pageUrl: 'https://pebble.example/', status: 503 },
      },
    ]);
    // Honest identification, redirects by hand, and no cookie ever sent.
    const siteCalls = calls.filter((call) => !(EGRESS_BEACONS as readonly string[]).includes(call.url));
    expect(siteCalls.every((call) => call.userAgent === SITE_ICONS_USER_AGENT && call.redirect === 'manual' && call.cookie === null)).toBe(true);
    // Every site answered with a status, so the gate was never asked.
    expect(result.egress.checked).toBe(false);
  });

  it('follows redirects and resolves the icons against the page they end on', async () => {
    const { fetchImpl } = stubOrigin({
      'https://meadow.example/': () => redirect('https://www.meadow.example/'),
      'https://www.meadow.example/': () => redirect('/en/', 302),
      'https://www.meadow.example/en/': () => html(RELATIVE_HREFS),
    });

    const result = await runSiteIcons(env, { fetchImpl, nowMs: NOW, assets: [MEADOW] });

    expect(result.reads).toEqual([
      {
        asset: 'meadow.example',
        outcome: 'read',
        light: 'https://www.meadow.example/en/icons/fav-48.png',
        dark: 'https://cdn.example.net/dark.svg',
      },
    ]);
    expect((await storedReads())[0]!.detail).toEqual({ pageUrl: 'https://www.meadow.example/en/', status: 200 });
  });

  it('calls an asset unreachable after five redirects', async () => {
    const routes: Record<string, () => Response> = {};
    for (let hop = 0; hop < 7; hop += 1) {
      routes[hop === 0 ? 'https://meadow.example/' : `https://meadow.example/hop-${hop}`] = () =>
        redirect(`https://meadow.example/hop-${hop + 1}`);
    }
    const { fetchImpl, calls } = stubOrigin(routes);

    const result = await runSiteIcons(env, { fetchImpl, nowMs: NOW, assets: [MEADOW] });

    expect(result.reads[0]!.outcome).toBe('unreachable');
    expect(calls).toHaveLength(6);
    expect((await storedReads())[0]!.detail).toEqual({
      pageUrl: 'https://meadow.example/hop-5',
      status: 301,
      error: 'more than 5 redirects',
    });
  });

  it('asks the www. host when the bare host does not answer', async () => {
    const { fetchImpl } = stubOrigin({
      ...EGRESS_UP,
      'https://www.meadow.example/': () => html(FAVICON_ONLY),
    });

    const result = await runSiteIcons(env, { fetchImpl, nowMs: NOW, assets: [MEADOW] });

    expect(result.reads).toEqual([
      { asset: 'meadow.example', outcome: 'read', light: 'https://www.meadow.example/favicon.ico', dark: null },
    ]);
  });

  it('reads no further than the end of the head, and never past 256 KB', async () => {
    let headPulls = 0;
    let fillerPulls = 0;
    const filler = new TextEncoder().encode(`<p>${'x'.repeat(64 * 1024)}</p>`);
    const endless = (first: string, count: () => void) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first));
        },
        pull(controller) {
          count();
          controller.enqueue(filler);
        },
      });
    const { fetchImpl } = stubOrigin({
      'https://meadow.example/': () => new Response(endless(LIGHT_AND_DARK_PNGS, () => (headPulls += 1)), { status: 200 }),
      // The head never ends: the icon after the first 256 KB is never read.
      'https://northwind.example/': () =>
        new Response(endless('<html><head><title>Long</title>', () => (fillerPulls += 1)), { status: 200 }),
    });

    const result = await runSiteIcons(env, { fetchImpl, nowMs: NOW, assets: [MEADOW, NORTHWIND] });

    expect(result.reads.map((read) => [read.asset, read.outcome])).toEqual([
      ['meadow.example', 'read'],
      ['northwind.example', 'no-icon'],
    ]);
    expect(headPulls).toBeLessThanOrEqual(2);
    expect(fillerPulls).toBeGreaterThanOrEqual(4);
    expect(fillerPulls).toBeLessThanOrEqual(6);
  });

  it('stores nothing for an asset when the OS itself cannot get out, and counts it on the egress flag', async () => {
    await runSiteIcons(env, {
      fetchImpl: stubOrigin({ ...EGRESS_UP, 'https://meadow.example/': () => html(FAVICON_ONLY) }).fetchImpl,
      nowMs: NOW - 86_400_000,
      assets: [MEADOW],
    });
    const offline = stubOrigin({});

    const result = await runSiteIcons(env, { fetchImpl: offline.fetchImpl, nowMs: NOW, assets: [MEADOW] });

    expect(result.reads).toEqual([{ asset: 'meadow.example', outcome: 'unmeasured', light: null, dark: null }]);
    expect(result.egress).toMatchObject({ checked: true, up: false, fired: 1, unmeasuredAssets: ['meadow.example'] });
    // Yesterday's read stands alone: an offline OS is not an unreachable site.
    expect((await storedReads()).map((read) => read.outcome)).toEqual(['read']);
    const [flag] = await flagRows(`rule_id = $1`, [EGRESS_DOWN_RULE_ID]);
    expect(JSON.parse(flag!.rule_inputs!).lanes.icons.unmeasuredAssets).toEqual(['meadow.example']);
  });

  it('calls a silent asset unreachable when the OS can get out', async () => {
    const { fetchImpl } = stubOrigin(EGRESS_UP);

    const result = await runSiteIcons(env, { fetchImpl, nowMs: NOW, assets: [MEADOW] });

    expect(result.reads[0]!.outcome).toBe('unreachable');
    expect(result.egress).toMatchObject({ checked: true, up: true, fired: 0 });
    expect((await storedReads())[0]!.detail).toEqual({
      pageUrl: 'https://meadow.example/',
      status: null,
      error: 'connection refused: https://meadow.example/',
    });
  });

  it('goes on to the next asset when one read cannot be stored', async () => {
    const { fetchImpl } = stubOrigin({
      'https://ghost.example/': () => html(FAVICON_ONLY),
      'https://meadow.example/': () => html(FAVICON_ONLY),
    });

    const result = await runSiteIcons(env, {
      fetchImpl,
      nowMs: NOW,
      // No site row holds this id, so its read is refused by the store.
      assets: [{ asset: 'ghost.example', domain: 'ghost.example' }, MEADOW],
    });

    expect(result.failed.map((failure) => failure.asset)).toEqual(['ghost.example']);
    expect((await storedReads()).map((read) => read.asset)).toEqual(['meadow.example']);
  });

  it('reads every asset with a domain that is not retired and is not the OS row', async () => {
    await changeSites(['puffin.example'], { status: 'retired' });
    try {
      const { fetchImpl, calls } = stubOrigin(EGRESS_UP);

      const result = await runSiteIcons(env, { fetchImpl, nowMs: NOW });

      const beacons: readonly string[] = EGRESS_BEACONS;
      const asked = new Set(
        calls.filter((call) => !beacons.includes(call.url)).map((call) => new URL(call.url).hostname.replace(/^www\./, '')),
      );
      expect([...asked].sort()).toEqual(['acorn.example', 'ferns.example', 'meadow.example', 'northwind.example', 'pebble.example']);
      expect(result.assets).toBe(5);
    } finally {
      await changeSites(['puffin.example'], { status: 'onboarding' });
    }
  });

  it('asks no asset while the store has no icon table yet', async () => {
    // The store as one the migration has not reached: its table lookup finds nothing.
    const unmigrated = (store: WorkspaceStore): WorkspaceStore => {
      const lookup = (tx: Transaction): Transaction => ({
        workspaceId: tx.workspaceId,
        query: (text, params) => tx.query(text.replace("to_regclass('noticeos.asset_icons')", "to_regclass('noticeos.no_such_table')"), params),
        execute: (text, params) => tx.execute(text, params),
      });
      return {
        where: store.where,
        workspaceId: () => store.workspaceId(),
        read: (work) => store.read((tx) => work(lookup(tx))),
        write: (work) => store.write((tx) => work(lookup(tx))),
        close: () => store.close(),
      };
    };
    const { fetchImpl, calls } = stubOrigin({ 'https://meadow.example/': () => html(FAVICON_ONLY) });

    const result = await runSiteIcons({ ...env, STORE: unmigrated(env.STORE) }, { fetchImpl, nowMs: NOW, assets: [MEADOW] });

    expect(result).toMatchObject({ skipped: 'not-migrated', assets: 0, reads: [], failed: [] });
    expect(calls).toEqual([]);
  });
});
