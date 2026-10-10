import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildReclamationImport, parseArgs, parseCsv, sendReclamationTargets } from './reclamation-import.mjs';

/** The request this file's fixture list builds. The ingest's own test posts
 * the same file through POST /api/reclamation-targets into a throwaway store
 * (workers/ingest/test/reclamation-targets.test.ts), so the two ends read one
 * contract. */
const REQUEST_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixture-reclamation-import/request.json', import.meta.url), 'utf8'),
);

/** A miniature target list in the origin's exact shape: quoted notes carrying
 * commas and doubled quotes, an unreachable contact left blank, and the
 * do-not-pitch pseudo-row as the last line. */
const FIXTURE_CSV = `tier,segment,domain,referring_page,links_to_dead,replace_with,contact,notes
1,extension,county.example.edu,https://county.example.edu/food/meals,dead.example.gov/,https://asset.example/food-groups,county@example.edu,"VERIFIED both links, anchor ""Visit DeadSite.gov online"""
1,library,guides.example.edu,https://guides.example.edu/nutrition,dead.example.gov/,https://asset.example/,,No published address; use the reference-desk form
2,editorial,news.example.com,https://news.example.com/articles/protein,dead.example.gov/protein,https://asset.example/food-groups,,DR92 — reach via the editorial feedback form
SKIP,federal,one.example.gov / two.example.gov / three.example.gov,n/a,n/a,n/a,n/a,"Do NOT pitch — federal hosts repoint to an official successor, never an independent site"
`;

const OVERLAY = [
  {
    domain: 'county.example.edu',
    status: 'clicked',
    statusAt: '2026-07-14',
    lastVerifiedAt: '2026-07-14',
    outcomeNote: 'Wave 1 sent 2026-06-16; recipient clicked.',
  },
];

function build(options = {}) {
  return buildReclamationImport({
    asset: 'asset.example',
    csvText: FIXTURE_CSV,
    overlay: OVERLAY,
    ...options,
  });
}

test('parses RFC 4180 fields — embedded commas, doubled quotes, and blanks', () => {
  const records = parseCsv(FIXTURE_CSV);
  assert.equal(records.length, 4);
  assert.equal(
    records[0].notes,
    'VERIFIED both links, anchor "Visit DeadSite.gov online"',
  );
  assert.equal(records[1].contact, '');
  assert.equal(records[0].domain, 'county.example.edu');
});

test('rejects a list whose columns are not the schema this importer reads', () => {
  assert.throws(
    () => parseCsv('domain,status\nexample.com,queued\n'),
    /Unexpected target-list columns/,
  );
});

test('imports every target once and splits the skip pseudo-row per domain', () => {
  const result = build();
  assert.equal(result.targetCount, 3);
  assert.equal(result.skipCount, 3);
  assert.equal(result.rows.length, 6);

  const skips = result.rows.filter((row) => row.status === 'skip');
  assert.deepEqual(
    skips.map((row) => row.domain),
    ['one.example.gov', 'two.example.gov', 'three.example.gov'],
  );
  // "is this host on the do-not-pitch list?" is a domain-grain question, so
  // every skip row keeps the shared reason and carries no page of its own.
  for (const row of skips) {
    assert.equal(row.referringPage, '');
    assert.match(row.notes, /Do NOT pitch/);
    // 'n/a' is the source spelling of "does not apply", never stored as text.
    assert.equal(row.linksToDead, null);
    assert.equal(row.replaceWith, null);
    assert.equal(row.contact, null);
    assert.equal(row.tier, null);
  }
});

test('a blank contact is unknown, not an empty string', () => {
  const row = build().rows.find((item) => item.domain === 'guides.example.edu');
  assert.equal(row.contact, null);
});

test('applies the encoded send state and leaves untouched targets queued', () => {
  const result = build();
  assert.equal(result.overlayCount, 1);
  assert.deepEqual(result.statusCounts, { clicked: 1, queued: 2, skip: 3 });

  const county = result.rows.find((row) => row.domain === 'county.example.edu');
  assert.equal(county.status, 'clicked');
  assert.equal(county.statusAt, '2026-07-14');
  assert.equal(county.lastVerifiedAt, '2026-07-14');
  assert.match(county.outcomeNote, /Wave 1 sent 2026-06-16/);

  const untouched = result.rows.find((row) => row.domain === 'news.example.com');
  assert.equal(untouched.status, 'queued');
  assert.equal(untouched.statusAt, null);
  assert.equal(untouched.outcomeNote, null);
});

test('--no-overlay imports the list alone', () => {
  const result = build({ overlay: [] });
  assert.equal(result.overlayCount, 0);
  assert.deepEqual(result.statusCounts, { queued: 3, skip: 3 });
});

test('an overlay entry that no longer matches the list is loud, not silent', () => {
  // A dropped send state is a double pitch on the next wave, so drift between
  // the CSV and the encoded state has to stop the import.
  assert.throws(
    () => build({ overlay: [{ domain: 'moved.example.edu', status: 'sent' }] }),
    /not in the target list/,
  );
});

test('an overlay entry matching several rows will not guess which one', () => {
  const twoPages = FIXTURE_CSV.replace(
    '2,editorial,news.example.com,https://news.example.com/articles/protein',
    '1,extension,county.example.edu,https://county.example.edu/nutrition/tips',
  );
  assert.throws(
    () => build({ csvText: twoPages }),
    /matches 2 target rows/,
  );
});

test('the request is every row, in list order, in the names the ingest reads', () => {
  // The ingest's route stores exactly this (its test posts this same file).
  assert.deepEqual(build().request, REQUEST_FIXTURE);
  assert.equal(build().request.targets.length, build().rows.length);
});

test('the same list builds the same request, so a diff is a real change', () => {
  assert.equal(JSON.stringify(build().request), JSON.stringify(build().request));
});

test('quotes in evidence text travel as written', () => {
  const county = build().request.targets.find((target) => target.domain === 'county.example.edu');
  assert.equal(county.notes, 'VERIFIED both links, anchor "Visit DeadSite.gov online"');
  const withApostrophe = build({
    csvText: FIXTURE_CSV.replace(
      'No published address; use the reference-desk form',
      "Rachel's team owns the sheet",
    ),
  });
  assert.equal(
    withApostrophe.request.targets.find((target) => target.domain === 'guides.example.edu').notes,
    "Rachel's team owns the sheet",
  );
});

test('sends the list to the ingest door with the operator bearer, and returns its answer', async () => {
  const calls = [];
  const answer = { ok: true, asset: 'asset.example', targets: 6, inserted: 6, moved: 0, verified: 0 };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json(answer);
  };
  const stored = await sendReclamationTargets(build().request, {
    door: 'http://127.0.0.1:65530',
    token: 'test-operator-token',
    fetchImpl,
  });
  assert.deepEqual(stored, answer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:65530/api/reclamation-targets');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-operator-token');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), REQUEST_FIXTURE);
});

test('a refusal from the door is the error, with what the ingest said', async () => {
  const fetchImpl = async () => Response.json({ error: 'unknown_asset', detail: 'asset.example' }, { status: 422 });
  await assert.rejects(
    sendReclamationTargets(build().request, { door: 'http://127.0.0.1:65530', token: 't', fetchImpl }),
    /api\/reclamation-targets answered HTTP 422 — .*unknown_asset/,
  );
});

test('--dry-run and --door are read; --out is gone with the SQL file', () => {
  const options = parseArgs(['--', '--asset', 'asset.example', '--csv', 'list.csv', '--dry-run', '--door', 'http://127.0.0.1:65530']);
  assert.equal(options.dryRun, true);
  assert.equal(options.door, 'http://127.0.0.1:65530');
  assert.equal(parseArgs(['--asset', 'asset.example', '--csv', 'list.csv']).dryRun, false);
  assert.throws(() => parseArgs(['--asset', 'asset.example', '--csv', 'list.csv', '--out', 'x.sql']), /Unknown option: --out/);
});

test('a list carrying the same page twice is rejected before it reaches the store', () => {
  const duplicated = `${FIXTURE_CSV}1,extension,county.example.edu,https://county.example.edu/food/meals,dead.example.gov/,https://asset.example/food-groups,county@example.edu,duplicate
`;
  assert.throws(() => build({ csvText: duplicated }), /duplicate \(domain, referring page\)/);
});

// An installation's send state is its own data: the product
// ships no overlay, and one installation keeps its in its own folder.
test("the overlay is the installation's own file, and without one there is none", async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { OVERLAY_FILE, readOverlay } = await import('./reclamation-import.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'reclamation-overlay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await readOverlay({ root, env: {} }), []);
  mkdirSync(path.join(root, 'installation'));
  writeFileSync(path.join(root, 'installation', OVERLAY_FILE), JSON.stringify([{ domain: 'a.example.edu', status: 'sent' }]));
  assert.deepEqual(await readOverlay({ root, env: {} }), [{ domain: 'a.example.edu', status: 'sent' }]);
  writeFileSync(path.join(root, 'installation', OVERLAY_FILE), '{"domain":"a.example.edu"}');
  await assert.rejects(readOverlay({ root, env: {} }), /must be an array/);
  assert.equal(build({ overlay: undefined }).overlayCount, 0, 'the import itself carries no overlay');
});
