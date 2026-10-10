import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN } from './fixtures.js';
import { bookEntry, call, effectiveRevenueMinor, reset, storedCount } from './helpers.js';

/** The one number the whole lane exists to protect: net revenue in exact cents
 * over the rows the store currently considers live. */
async function netMinor(): Promise<number> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ n: bigint }>(
      `SELECT COALESCE(SUM(CASE WHEN kind='revenue' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS n
         FROM noticeos.ledger_entries l
        WHERE kind IN ('revenue', 'cost')
          AND NOT EXISTS (SELECT 1 FROM noticeos.ledger_entries s WHERE s.supersedes_id = l.entry_id)`,
    ),
  );
  return Number(row?.n ?? 0n);
}

/** Ledger entries the store holds, where `where` says. */
const count = (where = 'true') => storedCount(`SELECT count(*)::int AS n FROM noticeos.ledger_entries WHERE ${where}`);

beforeEach(reset);

function revenueRequest(
  body: string | unknown,
  opts: { token?: string; csv?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': opts.csv ? 'text/csv' : 'application/json',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request('https://ingest.local/api/revenue', {
    method: 'POST',
    headers,
    body: opts.csv ? (body as string) : JSON.stringify(body),
  });
}

describe('POST /api/revenue — auth', () => {
  it('rejects a request without the operator token (401)', async () => {
    const res = await call(revenueRequest([{ kind: 'revenue' }]));
    expect(res.status).toBe(401);
  });

  it('rejects a wrong operator token (401)', async () => {
    const res = await call(revenueRequest([{ kind: 'revenue' }], { token: 'nope' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/revenue — JSON', () => {
  it('inserts a valid batch of revenue and cost rows (200)', async () => {
    const rows = [
      {
        kind: 'revenue',
        asset: 'meals.example',
        period: '2026-06',
        family: 'ads',
        amount: 412.5,
        source: 'raptive-report',
        booking_state: 'reconciled',
      },
      {
        kind: 'cost',
        asset: 'root-os',
        period: '2026-06',
        family: 'inference',
        amount: 18.2,
        ref: 'os-overhead',
        booking_state: 'estimated',
      },
    ];
    const res = await call(revenueRequest(rows, { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number; failed: number; results: unknown[] };
    expect(body).toMatchObject({ inserted: 2, failed: 0 });
    expect(await count()).toBe(2);
  });

  it('rejects a body that is not an array (400)', async () => {
    const res = await call(revenueRequest({ kind: 'revenue' }, { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/revenue — CSV', () => {
  it('parses a CSV export and inserts the rows (200)', async () => {
    const csv = [
      'kind,asset,period,family,amount,source,ref,booking_state,note',
      'revenue,meals.example,2026-06,ads,412.50,raptive-report,,reconciled,June ads',
      'cost,root-os,2026-06,inference,18.20,,os-overhead,estimated,',
    ].join('\n');
    const res = await call(revenueRequest(csv, { token: OPERATOR_TOKEN, csv: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number; failed: number };
    expect(body).toMatchObject({ inserted: 2, failed: 0 });
    expect(await count()).toBe(2);
  });
});

describe('POST /api/revenue — constraint rejection', () => {
  it('rejects a family that does not belong to the kind (422 when all invalid)', async () => {
    const rows = [
      {
        kind: 'revenue',
        asset: 'meals.example',
        period: '2026-06',
        family: 'inference', // cost family, not a revenue family
        amount: 1,
        booking_state: 'estimated',
      },
    ];
    const res = await call(revenueRequest(rows, { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { inserted: number; results: { ok: boolean; error: string }[] };
    expect(body.inserted).toBe(0);
    expect(body.results[0]).toMatchObject({ ok: false, error: 'validation' });
    expect(await count()).toBe(0);
  });

  it('flags an unknown asset per row', async () => {
    const rows = [
      {
        kind: 'revenue',
        asset: 'ghost.site',
        period: '2026-06',
        family: 'ads',
        amount: 1,
        booking_state: 'estimated',
      },
    ];
    const res = await call(revenueRequest(rows, { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { results: { ok: boolean; error: string }[] };
    expect(body.results[0]).toMatchObject({ ok: false, error: 'unknown_asset' });
  });

  it('inserts the valid rows and reports the invalid ones (partial success, 200)', async () => {
    const rows = [
      {
        kind: 'revenue',
        asset: 'meals.example',
        period: '2026-06',
        family: 'ads',
        amount: 100,
        booking_state: 'estimated',
      },
      {
        kind: 'revenue',
        asset: 'meals.example',
        period: 'bad-period',
        family: 'ads',
        amount: 1,
        booking_state: 'estimated',
      },
    ];
    const res = await call(revenueRequest(rows, { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inserted: number;
      failed: number;
      results: { ok: boolean }[];
    };
    expect(body).toMatchObject({ inserted: 1, failed: 1 });
    expect(body.results[0]?.ok).toBe(true);
    expect(body.results[1]?.ok).toBe(false);
    expect(await count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: the same export posted twice must not book the money twice.
// ---------------------------------------------------------------------------

const JUNE_EXPORT = [
  'kind,asset,period,family,amount,source,ref,booking_state,note',
  'revenue,meals.example,2026-06,ads,560.00,raptive-report,,estimated,June ads',
  'revenue,meals.example,2026-06,affiliate,168.20,cj-export,,estimated,CJ June',
  'cost,root-os,2026-06,inference,78.90,,os-overhead,estimated,',
].join('\n');

describe('POST /api/revenue — a re-uploaded file does not count the money twice', () => {
  it('stores one row per figure and leaves the total unmoved on replay', async () => {
    const first = await call(revenueRequest(JUNE_EXPORT, { token: OPERATOR_TOKEN, csv: true }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ inserted: 3, alreadyImported: 0, failed: 0 });

    const rowsAfterFirst = await count();
    const netAfterFirst = await netMinor();
    expect(rowsAfterFirst).toBe(3);
    expect(netAfterFirst).toBe(56000 + 16820 - 7890);

    // The operator uploads the same export again — the ordinary accident.
    const second = await call(revenueRequest(JUNE_EXPORT, { token: OPERATOR_TOKEN, csv: true }));
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      inserted: number;
      alreadyImported: number;
      failed: number;
      results: { ok: boolean; imported?: boolean; id: number | null }[];
    };
    expect(body).toMatchObject({ inserted: 0, alreadyImported: 3, failed: 0 });
    // Every row reports the row it did NOT duplicate, so the answer is auditable.
    for (const result of body.results) {
      expect(result).toMatchObject({ ok: true, imported: false });
      expect(typeof result.id).toBe('number');
    }

    expect(await count()).toBe(rowsAfterFirst);
    expect(await netMinor()).toBe(netAfterFirst);
  });

  it('collapses a row doubled inside one upload', async () => {
    const doubled = [
      'kind,asset,period,family,amount,source,ref,booking_state,note',
      'revenue,meals.example,2026-06,ads,560.00,raptive-report,,estimated,June ads',
      'revenue,meals.example,2026-06,ads,560.00,raptive-report,,estimated,June ads',
    ].join('\n');
    const res = await call(revenueRequest(doubled, { token: OPERATOR_TOKEN, csv: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 1, alreadyImported: 1, failed: 0 });
    expect(await count()).toBe(1);
    expect(await netMinor()).toBe(56000);
  });

  it("keys a source's own record id, so two payouts in one month stay two rows", async () => {
    const rows = [
      {
        kind: 'revenue',
        asset: 'meals.example',
        period: '2026-06',
        family: 'affiliate',
        amount: 40,
        source: 'cj-export',
        booking_state: 'estimated',
        external_id: 'SID-1',
      },
      {
        kind: 'revenue',
        asset: 'meals.example',
        period: '2026-06',
        family: 'affiliate',
        amount: 128.2,
        source: 'cj-export',
        booking_state: 'estimated',
        external_id: 'SID-2',
      },
    ];
    const res = await call(revenueRequest(rows, { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 2, alreadyImported: 0 });
    expect(await count()).toBe(2);
    // Namespaced by the source that issued them, so another provider's 'SID-1'
    // is a different row.
    expect(
      await count("external_id = 'cj-export:SID-1'"),
    ).toBe(1);

    // And replaying that file is still a no-op.
    await call(revenueRequest(rows, { token: OPERATOR_TOKEN }));
    expect(await count()).toBe(2);
  });

  it('refuses a replay that restates the figure, and says how to book it', async () => {
    const row = {
      kind: 'revenue',
      asset: 'meals.example',
      period: '2026-06',
      family: 'ads',
      amount: 560,
      source: 'raptive-report',
      booking_state: 'estimated',
    };
    await call(revenueRequest([row], { token: OPERATOR_TOKEN }));

    const res = await call(revenueRequest([{ ...row, amount: 498.1 }], { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      inserted: number;
      failed: number;
      results: { ok: boolean; error: string; detail?: string }[];
    };
    expect(body).toMatchObject({ inserted: 0, alreadyImported: 0, failed: 1 });
    expect(body.results[0]).toMatchObject({ ok: false, error: 'conflicting_replay' });
    expect(body.results[0]?.detail).toContain('supersedes_external_id');
    // The stored figure is untouched: history is not editable in place.
    expect(await netMinor()).toBe(56000);
    expect(await count()).toBe(1);
  });

  it('stores exact minor units and no dollars mirror', async () => {
    await call(revenueRequest(JUNE_EXPORT, { token: OPERATOR_TOKEN, csv: true }));
    // 168.20 is the value whose float product (16820.000000000002) is why the
    // column exists.
    // Kept as int8, and read back as the exact integer it is.
    const [stored] = await env.STORE.read((tx) =>
      tx.query<{ amount_minor: bigint }>(`SELECT amount_minor FROM noticeos.ledger_entries WHERE family = 'affiliate'`),
    );
    expect(Number(stored?.amount_minor)).toBe(16820);
    expect(
      await count("amount_minor IS NULL"),
    ).toBe(0);
    // There is no dollars column, so naming it is an error rather than a second
    // copy of the money.
    await expect(
      env.STORE.read((tx) => tx.query(`SELECT amount FROM noticeos.ledger_entries`)),
    ).rejects.toThrow(/amount/);
  });
});

describe('POST /api/revenue — reconciliation references the estimate by id', () => {
  const ESTIMATE_ID = 'raptive-report:auto/revenue/meals.example/2026-05/ads/estimated';

  const estimate = {
    kind: 'revenue',
    asset: 'meals.example',
    period: '2026-05',
    family: 'ads',
    amount: 512.4,
    source: 'raptive-report',
    booking_state: 'estimated',
  };

  it('links supersedes_id from the estimate stable id, leaving the estimate stored', async () => {
    const first = await call(revenueRequest([estimate], { token: OPERATOR_TOKEN }));
    const firstBody = (await first.json()) as { results: { id: number }[] };
    const estimateId = firstBody.results[0]!.id;

    const res = await call(
      revenueRequest(
        [
          {
            ...estimate,
            amount: 498.1,
            booking_state: 'reconciled',
            supersedes_external_id: ESTIMATE_ID,
          },
        ],
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number; results: { id: number }[] };
    expect(body.inserted).toBe(1);

    // The link names the estimate's own entry, read back by the number the
    // route answered with (its identity never leaves the store).
    const [row] = await env.STORE.read((tx) =>
      tx.query<{ supersedesId: bigint; amountMinor: bigint }>(
        `SELECT e.entry_number AS "supersedesId", r.amount_minor AS "amountMinor"
           FROM noticeos.ledger_entries r
           JOIN noticeos.ledger_entries e ON e.workspace_id = r.workspace_id AND e.entry_id = r.supersedes_id
          WHERE r.booking_state = 'reconciled'`,
      ),
    );
    const stored = row && { supersedesId: Number(row.supersedesId), amountMinor: Number(row.amountMinor) };
    // The link is the estimate's own row id — resolved from its stable id, not
    // matched on kind/period/family.
    expect(stored?.supersedesId).toBe(estimateId);
    expect(stored?.amountMinor).toBe(49810);

    // Append-only: both rows exist, and only the reconciled one is current.
    expect(await count()).toBe(2);
    expect(await netMinor()).toBe(49810);
  });

  it('refuses to supersede a row the store does not have', async () => {
    const res = await call(
      revenueRequest(
        [
          {
            ...estimate,
            booking_state: 'reconciled',
            supersedes_external_id: 'raptive-report:auto/revenue/meals.example/1999-01/ads/estimated',
          },
        ],
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { results: { ok: boolean; error: string }[] };
    expect(body.results[0]).toMatchObject({ ok: false, error: 'unknown_supersedes' });
    expect(await count()).toBe(0);
  });

  it('resolves an estimate uploaded in the same batch', async () => {
    const res = await call(
      revenueRequest(
        [
          estimate,
          {
            ...estimate,
            amount: 498.1,
            booking_state: 'reconciled',
            supersedes_external_id: ESTIMATE_ID,
          },
        ],
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 2, failed: 0 });
    const linked = await storedCount(
      `SELECT count(*)::int AS n FROM noticeos.ledger_entries r
         JOIN noticeos.ledger_entries e ON e.workspace_id = r.workspace_id AND e.entry_id = r.supersedes_id
        WHERE r.booking_state = 'reconciled' AND e.booking_state = 'estimated'`,
    );
    expect(linked).toBe(1);
    expect(await netMinor()).toBe(49810);
  });

  it('rejects an estimate that claims to supersede anything', async () => {
    const res = await call(
      revenueRequest([{ ...estimate, supersedes_external_id: ESTIMATE_ID }], {
        token: OPERATOR_TOKEN,
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { results: { ok: boolean; error: string }[] };
    expect(body.results[0]).toMatchObject({ ok: false, error: 'validation' });
  });
});

// ---------------------------------------------------------------------------
// One entry, one current figure. A correction may replace only an entry of the
// same asset, period, kind, family and currency, and only the entry that is
// current now.
// ---------------------------------------------------------------------------

interface UploadResult {
  index: number;
  ok: boolean;
  imported?: boolean;
  id?: number | null;
  error?: string;
  detail?: string;
  review?: { code: string; message: string };
}

interface UploadBody {
  inserted: number;
  alreadyImported: number;
  failed: number;
  reviewRequired: number;
  results: UploadResult[];
}

async function upload(rows: unknown[]): Promise<{ status: number; body: UploadBody }> {
  const res = await call(revenueRequest(rows, { token: OPERATOR_TOKEN }));
  return { status: res.status, body: (await res.json()) as UploadBody };
}

describe('POST /api/revenue — a correction replaces one current entry of the same identity', () => {
  const EST = 'raptive-report:est-may';
  const estimate = {
    kind: 'revenue',
    asset: 'meals.example',
    period: '2026-05',
    family: 'ads',
    amount: 100,
    source: 'raptive-report',
    booking_state: 'estimated',
    external_id: 'est-may',
  };
  const correction = (externalId: string, amount: number, supersedes: string, over: object = {}) => ({
    ...estimate,
    amount,
    booking_state: 'reconciled',
    external_id: externalId,
    supersedes_external_id: supersedes,
    ...over,
  });

  it.each([
    ['another asset', { asset: 'nosh.example' }, 'asset'],
    ['another period', { period: '2026-06' }, 'period'],
    ['another kind', { kind: 'cost', family: 'infra' }, 'kind, family'],
    ['another family', { family: 'affiliate' }, 'family'],
    [
      'the audit case: a cost for another property and month',
      { kind: 'cost', asset: 'root-os', period: '2026-06', family: 'inference' },
      'asset, period, kind, family',
    ],
  ])('refuses a correction for %s, naming what differs', async (_label, over, differs) => {
    await upload([estimate]);
    const { status, body } = await upload([correction('fix-1', 200, EST, over)]);
    expect(status).toBe(422);
    expect(body.results[0]).toMatchObject({ ok: false, error: 'supersedes_mismatch' });
    expect(body.results[0]?.detail).toContain(`(differs in ${differs})`);
    // Nothing was booked and the estimate still counts.
    expect(await count()).toBe(1);
    expect(await effectiveRevenueMinor()).toBe(10000);
  });

  it('refuses a correction of an entry booked in another currency', async () => {
    // The upload carries no currency (the lane is USD-only), so a non-USD entry
    // can only have been written by hand — which is exactly the row to protect.
    await bookEntry({
      kind: 'revenue', asset: 'meals.example', period: '2026-05', family: 'ads', amountMinor: 10000,
      currency: 'EUR', externalId: 'fx-report:eur-1', source: 'fx-report', bookingState: 'estimated',
    });
    const { status, body } = await upload([correction('fix-1', 200, 'fx-report:eur-1')]);
    expect(status).toBe(422);
    expect(body.results[0]).toMatchObject({ ok: false, error: 'supersedes_mismatch' });
    expect(body.results[0]?.detail).toContain('(differs in currency)');
    expect(await count()).toBe(1);
  });

  it('refuses to replace an entry that was already replaced, naming the current one', async () => {
    await upload([estimate]);
    expect((await upload([correction('fix-1', 200, EST)])).status).toBe(200);

    const { status, body } = await upload([correction('fix-2', 300, EST)]);
    expect(status).toBe(422);
    expect(body.results[0]).toMatchObject({ ok: false, error: 'already_superseded' });
    expect(body.results[0]?.detail).toContain("supersedes_external_id='raptive-report:fix-1'");
    expect(await effectiveRevenueMinor()).toBe(20000);

    // Following that advice extends the chain instead of branching it.
    const again = await upload([correction('fix-2', 300, 'raptive-report:fix-1')]);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ inserted: 1, failed: 0 });
    expect(await count("supersedes_id IS NOT NULL")).toBe(2);
    expect(await effectiveRevenueMinor()).toBe(30000);
  });

  it('books exactly one of two concurrent corrections of one estimate', async () => {
    await upload([estimate]);
    const [a, b] = await Promise.all([
      upload([correction('fix-a', 200, EST)]),
      upload([correction('fix-b', 300, EST)]),
    ]);
    const outcomes = [a, b].map((r) => r.body.results[0]);
    expect(outcomes.filter((r) => r?.ok)).toHaveLength(1);
    expect(outcomes.find((r) => !r?.ok)).toMatchObject({ ok: false, error: 'already_superseded' });
    // Both landing would make 100¢ into 200¢ + 300¢ = 500¢.
    const winner = a.body.results[0]?.ok ? 20000 : 30000;
    expect(await effectiveRevenueMinor()).toBe(winner);
    expect(await count()).toBe(2);
  });

  it('refuses two rows of one upload that replace the same entry — and their copies', async () => {
    await upload([estimate]);
    const { status, body } = await upload([
      correction('fix-a', 200, EST),
      correction('fix-a', 200, EST),
      correction('fix-b', 300, EST),
    ]);
    expect(status).toBe(422);
    expect(body).toMatchObject({ inserted: 0, alreadyImported: 0, failed: 3 });
    expect(body.results[0]).toMatchObject({ ok: false, error: 'duplicate_supersedes' });
    expect(body.results[0]?.detail).toContain('rows 0, 2');
    expect(body.results[2]).toMatchObject({ ok: false, error: 'duplicate_supersedes' });
    // The doubled line follows its first copy instead of claiming a booking.
    expect(body.results[1]).toMatchObject({ ok: false, error: 'duplicate_supersedes' });
    expect(await count()).toBe(1);
    expect(await effectiveRevenueMinor()).toBe(10000);
  });

  it('refuses a same-upload branch on a new estimate while booking the estimate', async () => {
    const { status, body } = await upload([
      estimate,
      correction('fix-a', 200, EST),
      correction('fix-b', 300, EST),
    ]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ inserted: 1, failed: 2 });
    expect(body.results[1]).toMatchObject({ ok: false, error: 'duplicate_supersedes' });
    expect(body.results[2]).toMatchObject({ ok: false, error: 'duplicate_supersedes' });
    expect(await effectiveRevenueMinor()).toBe(10000);
  });

  it('checks identity against an estimate uploaded in the same batch', async () => {
    const { status, body } = await upload([
      estimate,
      correction('fix-1', 200, EST, { asset: 'nosh.example' }),
    ]);
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({ ok: true, imported: true });
    expect(body.results[1]).toMatchObject({ ok: false, error: 'supersedes_mismatch' });
    expect(body.results[1]?.detail).toContain('(differs in asset)');
    expect(await count()).toBe(1);
  });

  it('refuses a row that names itself as the entry it replaces', async () => {
    const { status, body } = await upload([correction('fix-1', 200, 'raptive-report:fix-1')]);
    expect(status).toBe(422);
    expect(body.results[0]).toMatchObject({ ok: false, error: 'supersedes_self' });
    expect(await count()).toBe(0);
  });

  it('books a two-link chain in one upload when the first link targets a stored estimate', async () => {
    await upload([estimate]);
    const { status, body } = await upload([
      correction('fix-1', 200, EST),
      correction('fix-2', 300, 'raptive-report:fix-1'),
    ]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ inserted: 2, failed: 0 });
    expect(await effectiveRevenueMinor()).toBe(30000);
  });
});

describe('POST /api/revenue — a replay must match the stored link and currency too', () => {
  const estimate = (externalId: string) => ({
    kind: 'revenue',
    asset: 'meals.example',
    period: '2026-05',
    family: 'ads',
    amount: 100,
    source: 'raptive-report',
    booking_state: 'estimated',
    external_id: externalId,
  });
  const fix = (supersedes?: string) => ({
    ...estimate('fix-1'),
    amount: 200,
    booking_state: 'reconciled',
    ...(supersedes === undefined ? {} : { supersedes_external_id: supersedes }),
  });

  it('refuses the same key and amount with a changed or removed link', async () => {
    await upload([estimate('est-a'), estimate('est-b')]);
    expect((await upload([fix('raptive-report:est-a')])).body.inserted).toBe(1);
    const before = await effectiveRevenueMinor();

    const changed = await upload([fix('raptive-report:est-b')]);
    expect(changed.status).toBe(422);
    expect(changed.body.results[0]).toMatchObject({ ok: false, error: 'conflicting_replay' });
    expect(changed.body.results[0]?.detail).toContain("replaces 'raptive-report:est-a'");

    const removed = await upload([fix()]);
    expect(removed.status).toBe(422);
    expect(removed.body.results[0]).toMatchObject({ ok: false, error: 'conflicting_replay' });
    expect(removed.body.results[0]?.detail).toContain('replaces nothing');

    // The identical replay is still a no-op.
    const same = await upload([fix('raptive-report:est-a')]);
    expect(same.status).toBe(200);
    expect(same.body.results[0]).toMatchObject({ ok: true, imported: false });
    expect(await count()).toBe(3);
    expect(await effectiveRevenueMinor()).toBe(before);
  });

  it('refuses the same key with a link added after the fact', async () => {
    await upload([estimate('est-a')]);
    expect((await upload([fix()])).body.inserted).toBe(1);
    const { status, body } = await upload([fix('raptive-report:est-a')]);
    expect(status).toBe(422);
    expect(body.results[0]).toMatchObject({ ok: false, error: 'conflicting_replay' });
    expect(await count("supersedes_id IS NOT NULL")).toBe(0);
  });

  it('refuses the same key two ways inside one upload', async () => {
    await upload([estimate('est-a'), estimate('est-b')]);
    const { body } = await upload([fix('raptive-report:est-a'), fix('raptive-report:est-b')]);
    expect(body.results[0]).toMatchObject({ ok: true, imported: true });
    expect(body.results[1]).toMatchObject({ ok: false, error: 'conflicting_replay' });
  });

  it('refuses a replay of a key the store holds in another currency', async () => {
    await bookEntry({
      kind: 'revenue', asset: 'meals.example', period: '2026-05', family: 'ads', amountMinor: 10000,
      currency: 'EUR', externalId: 'raptive-report:est-a', source: 'raptive-report', bookingState: 'estimated',
    });
    const { status, body } = await upload([estimate('est-a')]);
    expect(status).toBe(422);
    expect(body.results[0]).toMatchObject({ ok: false, error: 'conflicting_replay' });
    expect(body.results[0]?.detail).toContain('EUR');
  });
});


describe('POST /api/revenue — coverage is data, not note wording', () => {
  const note = 'Mediavine Journey, 7/30 days — PARTIAL, covers 2026-06-01..2026-06-07';
  const row = { kind: 'revenue', asset: 'meals.example', period: '2026-06', family: 'ads', amount: 9, source: 'mediavine-journey', booking_state: 'estimated', note };
  const explicit = { coverage_start: '2026-06-01', coverage_end: '2026-06-07', coverage_complete: false };
  const coverage = async () => env.STORE.read((tx) => tx.query<{
    start: string | null; end: string | null; complete: boolean | null;
  }>(`SELECT to_char(coverage_start, 'YYYY-MM-DD') AS start, to_char(coverage_end, 'YYYY-MM-DD') AS end,
             coverage_complete AS complete FROM noticeos.ledger_entries ORDER BY entry_number`));

  it('replays identical explicit coverage with different notes without rewriting the booking', async () => {
    expect((await upload([{ ...row, ...explicit }])).body).toMatchObject({ inserted: 1, failed: 0, reviewRequired: 0 });
    const again = await upload([{ ...row, ...explicit, note: 'Updated dashboard description' }]);
    expect(again.body).toMatchObject({ inserted: 0, alreadyImported: 1, failed: 0, reviewRequired: 0 });
    expect(await coverage()).toEqual([{ start: '2026-06-01', end: '2026-06-07', complete: false }]);
    expect(await effectiveRevenueMinor('meals.example')).toBe(900);
  });

  it('retains the legacy note rule only when no structured fields are supplied', async () => {
    expect((await upload([row])).body).toMatchObject({ inserted: 1, failed: 0, reviewRequired: 0 });
    expect(await coverage()).toEqual([{ start: null, end: '2026-06-07', complete: null }]);
  });

  it.each([
    [{ coverage_complete: false }, { start: null, end: null, complete: false }],
    [{ coverage_end: null }, { start: null, end: null, complete: null }],
    [{ coverage_start: '2026-06-01' }, { start: '2026-06-01', end: null, complete: null }],
  ])('does not fill missing explicit coverage from a note (%j)', async (fields, expected) => {
    expect((await upload([{ ...row, ...fields }])).body).toMatchObject({ inserted: 1, failed: 0, reviewRequired: 0 });
    expect(await coverage()).toEqual([expected]);
  });

  it.each([
    'Mediavine Journey, 7/30 days — PARTIAL, covers unreadable',
    'Mediavine Journey, 7/30 days - PARTIAL, covers 2026-06-01..2026-06-07',
  ])('books ambiguous legacy coverage conservatively and reports the row for review (%s)', async (legacyNote) => {
    const result = await upload([{ ...row, note: legacyNote }]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ inserted: 1, failed: 0, reviewRequired: 1 });
    expect(result.body.results[0]).toMatchObject({ index: 0, ok: true, imported: true, review: { code: 'coverage_note_unreadable' } });
    expect(result.body.results[0]?.review?.message).toContain('Row booked with unknown coverage');
    expect(await coverage()).toEqual([{ start: null, end: null, complete: null }]);
    const again = await upload([{ ...row, note: legacyNote }]);
    expect(again.body).toMatchObject({ inserted: 0, alreadyImported: 1, failed: 0, reviewRequired: 1 });
    expect(again.body.results[0]?.review?.message).toContain('stored coverage was retained');
  });

  it.each([{ coverage_start: '2026-06-02' }, { coverage_end: '2026-06-08' }, { coverage_complete: true }])(
    'refuses explicit coverage changes under a booked stable id (%j)', async (change) => {
      await upload([{ ...row, ...explicit }]);
      const result = await upload([{ ...row, ...explicit, ...change }]);
      expect(result.body).toMatchObject({ inserted: 0, alreadyImported: 0, failed: 1, reviewRequired: 0 });
      expect(result.body.results[0]).toMatchObject({ error: 'conflicting_replay' });
      expect(result.body.results[0]?.detail).toContain('different coverage');
      expect(await coverage()).toEqual([{ start: '2026-06-01', end: '2026-06-07', complete: false }]);
    },
  );

  it('refuses a different explicit coverage tuple repeated inside one upload', async () => {
    const result = await upload([{ ...row, ...explicit }, { ...row, ...explicit, coverage_end: '2026-06-08' }]);
    expect(result.body).toMatchObject({ inserted: 1, failed: 1 });
    expect(result.body.results[1]).toMatchObject({ error: 'conflicting_replay' });
    expect(await count()).toBe(1);
  });

  it('reads CSV coverage_complete=false literally and writes complete coverage fields', async () => {
    const csv = 'kind,asset,period,family,amount,source,booking_state,coverage_start,coverage_end,coverage_complete,note\n' +
      'revenue,meals.example,2026-06,ads,9,mediavine-journey,estimated,2026-06-01,2026-06-07,false,Display text';
    const result = await call(revenueRequest(csv, { token: OPERATOR_TOKEN, csv: true }));
    expect(result.status).toBe(200);
    expect(await coverage()).toEqual([{ start: '2026-06-01', end: '2026-06-07', complete: false }]);
  });
});


describe('POST /api/revenue — stated currency', () => {
  const row = { kind: 'revenue', asset: 'meals.example', period: '2026-06', family: 'ads', amount: 12.345, source: 'currency-upload', booking_state: 'estimated', external_id: 'entry' };
  it('books supported currency precision in the actual Worker and preserves it on replay', async () => {
    for (const [currency, minor] of [['EUR', 1235], ['JPY', 12], ['KWD', 12345]] as const) {
      const entry = { ...row, currency, external_id: currency };
      expect((await call(revenueRequest([entry], { token: OPERATOR_TOKEN }))).status).toBe(200);
      const [stored] = await env.STORE.read(tx => tx.query<{currency: string; amount_minor: bigint}>(
        'SELECT currency, amount_minor FROM noticeos.ledger_entries WHERE external_id=$1', [`currency-upload:${currency}`]));
      expect(stored).toEqual({ currency, amount_minor: BigInt(minor) });
      expect(await (await call(revenueRequest([entry], { token: OPERATOR_TOKEN }))).json()).toMatchObject({ alreadyImported: 1 });
    }
  });
  it('refuses currency changes on replay and corrections, but accepts same-currency corrections', async () => {
    const eur = { ...row, currency: 'EUR' };
    expect((await call(revenueRequest([eur], { token: OPERATOR_TOKEN }))).status).toBe(200);
    const changed = await call(revenueRequest([{ ...eur, currency: 'USD' }], { token: OPERATOR_TOKEN }));
    expect(await changed.json()).toMatchObject({ results: [{ error: 'conflicting_replay' }] });
    const correction = { ...eur, external_id: 'corrected', supersedes_external_id: 'currency-upload:entry', booking_state: 'reconciled', amount: 14.01 };
    const foreign = await call(revenueRequest([{ ...correction, currency: 'JPY' }], { token: OPERATOR_TOKEN }));
    expect(await foreign.json()).toMatchObject({ results: [{ error: 'supersedes_mismatch' }] });
    expect((await call(revenueRequest([correction], { token: OPERATOR_TOKEN }))).status).toBe(200);
    const [stored] = await env.STORE.read(tx => tx.query<{currency: string; amount_minor: bigint}>(
      'SELECT currency, amount_minor FROM noticeos.ledger_entries WHERE external_id=$1', ['currency-upload:corrected']));
    expect(stored).toEqual({ currency: 'EUR', amount_minor: 1401n });
  });
  it('refuses unsupported codes before booking anything', async () => {
    const response = await call(revenueRequest([{ ...row, currency: 'XYZ' }, { ...row, currency: 'eur' }], { token: OPERATOR_TOKEN }));
    expect(response.status).toBe(422);
    expect(await count()).toBe(0);
  });
});
