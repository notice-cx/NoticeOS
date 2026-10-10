// POST /api/reclamation-targets — a campaign's target list. The request is the
// one scripts/reclamation-import.mjs builds from its test's fixture list
// (scripts/reclamation-import.test.mjs asserts the same file), posted here into
// this file's throwaway copy of the store.
//
// GET /api/reclamation-targets?asset=&open=1 — the site's open targets, read
// back for `pnpm reclamation:open-targets`. Its answer is the one
// scripts/reclamation-open-targets.test.mjs turns into the rule's file (the
// same fixture).

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { javascriptInstant, type Transaction, type WorkspaceStore } from '@noticeos/postgres';
import openAnswer from '../../../scripts/fixture-reclamation-import/open-targets.json';
import request from '../../../scripts/fixture-reclamation-import/request.json';
import { RECLAMATION_TARGETS_MAX, handleOpenReclamationTargets } from '../src/routes/reclamation-targets.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call, reset } from './helpers.js';

beforeEach(reset);

const SITE = 'meadow.example';
const LIST = { ...request, asset: SITE };

function post(body: unknown, token: string | null = OPERATOR_TOKEN): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('https://ingest.local/api/reclamation-targets', { method: 'POST', headers, body: JSON.stringify(body) });
}

type StoredTarget = {
  number: number;
  domain: string;
  referring_page: string;
  tier: number | null;
  contact: string | null;
  status: string;
  status_at: string | null;
  last_verified_at: string | null;
  outcome_note: string | null;
};

/** The site's stored targets, in the order they were stored. */
async function stored(): Promise<StoredTarget[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<Omit<StoredTarget, 'number'> & { number: string }>(
      `SELECT target_number::text AS number, domain, referring_page, tier, contact, status, status_at, last_verified_at, outcome_note
         FROM noticeos.reclamation_targets WHERE asset_id = $1 ORDER BY target_number`,
      [SITE],
    ),
  );
  const instant = (value: string | null) => (value === null ? null : javascriptInstant(value));
  return rows.map((row) => ({
    ...row,
    number: Number(row.number),
    status_at: instant(row.status_at),
    last_verified_at: instant(row.last_verified_at),
  }));
}

/** Move one stored target on, as a person recording a reply or a win does. */
async function setStatus(domain: string, status: string): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(`UPDATE noticeos.reclamation_targets SET status = $2, updated_at = now() WHERE asset_id = $3 AND domain = $1`, [
      domain,
      status,
      SITE,
    ]),
  );
}

describe('POST /api/reclamation-targets', () => {
  it('stores every page of the list once, with the send state it carries', async () => {
    const res = await call(post(LIST));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, asset: SITE, targets: 6, inserted: 6, moved: 0, verified: 0 });

    const rows = await stored();
    expect(rows.map((row) => [row.domain, row.referring_page, row.status])).toEqual([
      ['county.example.edu', 'https://county.example.edu/food/meadow', 'clicked'],
      ['guides.example.edu', 'https://guides.example.edu/nutrition', 'queued'],
      ['news.example.com', 'https://news.example.com/articles/protein', 'queued'],
      ['one.example.gov', '', 'skip'],
      ['two.example.gov', '', 'skip'],
      ['three.example.gov', '', 'skip'],
    ]);
    // Numbered by the workspace in list order.
    expect(rows.map((row) => row.number - rows[0]!.number)).toEqual([0, 1, 2, 3, 4, 5]);
    // A day is its first instant, 00:00 UTC; "no contact" is NULL, never ''.
    expect(rows[0]).toMatchObject({
      tier: 1,
      contact: 'county@example.edu',
      status_at: '2026-07-14T00:00:00.000Z',
      last_verified_at: '2026-07-14T00:00:00.000Z',
      outcome_note: 'Wave 1 sent 2026-06-16; recipient clicked.',
    });
    expect(rows[1]).toMatchObject({ contact: null, status_at: null, last_verified_at: null });
    expect(rows[3]).toMatchObject({ tier: null });
  });

  it('changes nothing when the same list is imported again', async () => {
    await call(post(LIST));
    const before = await stored();
    const res = await call(post(LIST));
    expect(await res.json()).toEqual({ ok: true, asset: SITE, targets: 6, inserted: 0, moved: 0, verified: 0 });
    expect(await stored()).toEqual(before);
  });

  it('moves a stored page forward, never back, and never off a status a person set', async () => {
    // The list without its send state first, as a campaign's first import.
    const queued = LIST.targets.map((target) => ({ ...target, status: target.status === 'skip' ? 'skip' : 'queued', statusAt: null, lastVerifiedAt: null, outcomeNote: null }));
    await call(post({ ...LIST, targets: queued }));
    await setStatus('guides.example.edu', 'replied');
    await setStatus('news.example.com', 'won');

    // Then the recorded state: county was clicked; guides and news are
    // further along by a person's hand than this list says.
    const recorded = LIST.targets.map((target) =>
      target.domain === 'guides.example.edu' || target.domain === 'news.example.com'
        ? { ...target, status: 'sent', statusAt: '2026-07-01' }
        : target,
    );
    const res = await call(post({ ...LIST, targets: recorded }));
    expect(await res.json()).toEqual({ ok: true, asset: SITE, targets: 6, inserted: 0, moved: 1, verified: 1 });

    const byDomain = new Map((await stored()).map((row) => [row.domain, row]));
    expect(byDomain.get('county.example.edu')).toMatchObject({ status: 'clicked', status_at: '2026-07-14T00:00:00.000Z', last_verified_at: '2026-07-14T00:00:00.000Z' });
    expect(byDomain.get('guides.example.edu')).toMatchObject({ status: 'replied', status_at: null });
    expect(byDomain.get('news.example.com')).toMatchObject({ status: 'won' });
    expect(byDomain.get('one.example.gov')).toMatchObject({ status: 'skip' });
  });

  it('moves a verification stamp only forward', async () => {
    await call(post(LIST));
    const older = LIST.targets.map((target) => (target.lastVerifiedAt ? { ...target, lastVerifiedAt: '2026-07-01' } : target));
    expect(await (await call(post({ ...LIST, targets: older }))).json()).toMatchObject({ verified: 0 });
    const newer = LIST.targets.map((target) => (target.lastVerifiedAt ? { ...target, lastVerifiedAt: '2026-08-02T09:30:00.000Z' } : target));
    expect(await (await call(post({ ...LIST, targets: newer }))).json()).toMatchObject({ verified: 1 });
    expect((await stored())[0]!.last_verified_at).toBe('2026-08-02T09:30:00.000Z');
  });

  it('refuses a caller without the operator token', async () => {
    expect((await call(post(LIST, null))).status).toBe(401);
    expect((await call(post(LIST, 'nope'))).status).toBe(401);
    expect(await stored()).toEqual([]);
  });

  it('refuses a site the store does not hold, naming it', async () => {
    const res = await call(post({ ...LIST, asset: 'not-a-site.example' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'unknown_asset', detail: 'not-a-site.example' });
  });

  it('refuses a list it cannot store whole, naming every problem, and stores none of it', async () => {
    const bad = [
      { ...LIST.targets[0]!, status: 'bounced' },
      { ...LIST.targets[1]!, domain: '' },
      { ...LIST.targets[2]!, statusAt: 'last tuesday' },
      { ...LIST.targets[3]!, tier: 0 },
      LIST.targets[4]!,
    ];
    const res = await call(post({ ...LIST, targets: bad }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('validation');
    expect(body.issues.map((issue) => issue.path)).toEqual([
      'targets[0].status',
      'targets[1].domain',
      'targets[2].statusAt',
      'targets[3].tier',
    ]);
    expect(await stored()).toEqual([]);
    // A page listed twice is refused too.
    const twice = await call(post({ ...LIST, targets: [LIST.targets[1], LIST.targets[1]] }));
    expect(((await twice.json()) as { issues: { path: string; code: string }[] }).issues).toEqual([
      expect.objectContaining({ path: 'targets[1]', code: 'duplicate' }),
    ]);
  });
});

function get(query: string, token: string | null = OPERATOR_TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://ingest.local/api/reclamation-targets${query}`, { headers });
}

/** Targets a later list adds, stored after the fixture's six. The open ones
 * run against the alphabet, so an answer sorted by name would show it. */
const LATER = [
  { domain: 'zoo.example.org', referringPage: 'https://zoo.example.org/kids/food', replaceWith: 'https://asset.example/kids', status: 'sent' },
  { domain: 'art.example.org', referringPage: 'https://art.example.org/still-life', replaceWith: null, status: 'replied' },
  { domain: 'www.Museum.example.org', referringPage: '', replaceWith: 'https://asset.example/', status: 'opened' },
  { domain: 'gone.example.org', referringPage: 'https://gone.example.org/pantry', replaceWith: null, status: 'queued' },
].map((target) => ({
  tier: 3,
  segment: null,
  linksToDead: null,
  contact: null,
  notes: null,
  statusAt: null,
  lastVerifiedAt: null,
  outcomeNote: null,
  ...target,
}));

describe('GET /api/reclamation-targets?open=1', () => {
  it('answers the open targets in the order they were stored, leaving won, skip and dead out', async () => {
    expect((await call(post({ ...LIST, targets: [...LIST.targets, ...LATER] }))).status).toBe(200);
    // A person records a win and a dead page; the list's three skips stay.
    await setStatus('news.example.com', 'won');
    await setStatus('gone.example.org', 'dead');

    const res = await call(get(`?asset=${SITE}&open=1`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...openAnswer, asset: SITE });
    // Every open status is in the answer, and no closed one.
    const statuses = new Set(openAnswer.targets.map((target) => target.status));
    expect([...statuses].sort()).toEqual(['clicked', 'opened', 'queued', 'replied', 'sent']);
  });

  it('answers an empty list for a site that holds no open target', async () => {
    const res = await call(get(`?asset=${SITE}&open=1`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, asset: SITE, targets: [] });
  });

  it('refuses a caller without the operator token, a request without a site or open=1, and names a site the store does not hold', async () => {
    expect((await call(get(`?asset=${SITE}&open=1`, null))).status).toBe(401);
    expect((await call(get(`?asset=${SITE}&open=1`, 'nope'))).status).toBe(401);
    expect((await call(get('?open=1'))).status).toBe(400);
    expect((await call(get(`?asset=${SITE}`))).status).toBe(400);
    const unknown = await call(get('?asset=not-a-site.example&open=1'));
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ error: 'unknown_asset', detail: 'not-a-site.example' });
  });

  it('is bounded as a list is: a site holding more open targets is refused, never answered in part', async () => {
    const many = Array.from({ length: RECLAMATION_TARGETS_MAX }, (_, index) => ({
      ...LATER[0]!,
      domain: `t${index}.example.org`,
      status: 'queued',
    }));
    expect((await call(post({ ...LIST, targets: many }))).status).toBe(200);
    const full = await call(get(`?asset=${SITE}&open=1`));
    expect(full.status).toBe(200);
    expect(((await full.json()) as { targets: unknown[] }).targets).toHaveLength(RECLAMATION_TARGETS_MAX);

    expect((await call(post({ ...LIST, targets: [LATER[1]] }))).status).toBe(200);
    const over = await call(get(`?asset=${SITE}&open=1`));
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({
      error: 'too_many',
      detail: `${SITE} holds more than ${RECLAMATION_TARGETS_MAX} open targets`,
    });
  });

  it('reads the targets table and the site check the POST makes too, and writes nothing', async () => {
    await call(post(LIST));
    const statements: string[] = [];
    const watched = (tx: Transaction): Transaction => ({
      workspaceId: tx.workspaceId,
      query: (sql, params) => {
        statements.push(sql);
        return tx.query(sql, params);
      },
      execute: (sql, params) => {
        statements.push(sql);
        return tx.execute(sql, params);
      },
    });
    const store: WorkspaceStore = {
      where: env.STORE.where,
      workspaceId: () => env.STORE.workspaceId(),
      read: (work) => env.STORE.read((tx) => work(watched(tx))),
      write: (work) => env.STORE.write((tx) => work(watched(tx))),
      close: () => env.STORE.close(),
    };
    const res = await handleOpenReclamationTargets(get(`?asset=${SITE}&open=1`), {
      ...env,
      STORE: store,
    } as unknown as IngestEnv);
    expect(res.status).toBe(200);
    // The site check, then the targets: each statement names one table.
    const named = statements.map((sql) => [...sql.matchAll(/noticeos\.([a-z_]+)/gu)].map((match) => match[1]));
    expect(named).toEqual([['assets'], ['reclamation_targets']]);
    for (const sql of statements) expect(sql).toMatch(/^\s*SELECT\b/u);
  });
});
