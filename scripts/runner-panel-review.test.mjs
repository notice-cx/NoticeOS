import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTaskProjects, readTaskProjectConfig } from './task-project-config.mjs';
import { linkedProjects, openStandaloneTasks } from './standalone-mcp.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

import { CONFIG } from './runner/config.mjs';
import {
  INVALID_PANEL_REVIEW_LABEL,
  PANEL_REVIEW_LABEL,
  panelReviewAlreadyFiled,
  panelReviewDueDate,
  panelReviewEntry,
  panelReviewListArgs,
  panelReviewCreateArgs,
  filePanelReview,
  panelReviewPanelDate,
  panelPublicationGap,
  readPublishedFreshness,
  readPublishedVersion,
  panelReviewTitle,
  runPanelReviewFiler,
  serpPanelLandingsUrl,
} from './runner/panel-review.mjs';

// scripts/runner/panel-review.mjs: the panel-review
// vocabulary and the filer that writes review beads. The filer is driven with
// a canned door and a recording `bd`; nothing reaches a real tracker.

const UP = { running: true, ready: true };
const VERSION = '00000004-2026-09-22T13-10-04-637Z-4f83dc';
const PROJECTS = JSON.stringify({ spokes: [{ asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' }] });

test('a no-checkout review waits for publication and reconciles a lost create across concurrent polls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-review-no-checkout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = { asset: 'shop.example', prefix: 'shop', database: 'shop' };
  const options = { repoRoot: root, env: {}, token: 'fixture',
    readHost: async () => JSON.stringify({ repositories: [project] }),
    fetchImpl: async () => Response.json({ ready: true, documents: [{ file: 'config/beads.json', version: 1, body: { spokes: [project] } }] }) };
  const projects = linkedProjects({ read: () => readTaskProjects(options) });
  const [connection] = await readTaskProjects(options);
  const receipts = memoryReceipts(Date.now), rows = [], commands = [];
  let closes = 0, creates = 0, publishedNow = false, loseResponse = true;
  const store = { onlyWorkspace: async () => '5f42e967-bb21-4e9b-9c69-8b082e8491a6', close: async () => { closes++; },
    inWorkspace: async (_workspace, work) => work({ query: async sql => sql.includes('pg_try_advisory') ? [{ acquired: true }] : [] }) };
  const client = async (argv, cwd) => {
    assert.equal(cwd, connection.cwd);
    commands.push(argv);
    const flag = name => argv.find(word => word.startsWith(name + '='))?.slice(name.length + 1);
    if (argv.includes('create')) {
      creates++;
      assert.equal(flag('--due'), '2026-09-28');
      rows.push({ id: `shop-${creates}`, title: flag('--title'), status: 'open', issue_type: 'task',
        labels: ['panel-review'], metadata: JSON.parse(flag('--metadata')), created_at: new Date().toISOString() });
      if (loseResponse) { loseResponse = false; return { code: 1, stdout: '' }; }
    }
    return { code: 0, stdout: JSON.stringify(argv.includes('create') ? rows.at(-1) : rows) };
  };
  const pass = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4,
    reports: ['serp-panel', 'ranked-keywords'] }] });
  Object.assign(pass.deps, {
    readConfig: () => readTaskProjectConfig(options),
    // A stale ordinary list cannot cause a duplicate: receipt recovery performs
    // its own complete read and matches the operation identity on the task.
    run: async argv => { assert.equal(argv[1], connection.cwd); return { code: 0, stdout: '[]' }; },
    readPublished: async () => publishedNow ? published(project.asset, '2026-09-21', ['serp-panel', 'ranked-keywords']) : null,
    createReview: (resolved, landing) => filePanelReview(resolved, landing, {
      readBindings: async () => ({ bindings: { DATABASE_URL: 'synthetic-bootstrap-address' } }),
      open: options => {
        assert.equal(options.databaseUrl, 'synthetic-bootstrap-address');
        return openStandaloneTasks({ store, projects, receipts, run: client });
      },
    }),
  });
  await Promise.all([runPanelReviewFiler(UP, pass.deps), runPanelReviewFiler(UP, pass.deps)]);
  assert.equal(creates, 0); assert.equal(closes, 0);
  publishedNow = true;
  await Promise.all([runPanelReviewFiler(UP, pass.deps), runPanelReviewFiler(UP, pass.deps)]);
  assert.equal(creates, 1); assert.equal(rows.length, 1);
  for (let poll = 0; poll < 3; poll++) await runPanelReviewFiler(UP, pass.deps);
  assert.equal(creates, 1); assert.equal(rows.length, 1);
  assert.equal(rows[0].metadata.noticeos_panel_version, VERSION);
  const create = commands.find(argv => argv.includes('create'));
  assert.ok(create.some(arg => arg.includes(`get_panel asset=shop.example version=${VERSION}`)));
  assert.ok(commands.some(argv => argv.includes('--limit=0') && argv.includes('list')), 'lost response was reconciled through complete task reads');
  assert.equal(closes, 5, 'every opened operation store is closed, including failed and concurrent writes');
  rows[0].labels.push('invalid-automation');
  pass.deps.run = async argv => { assert.equal(argv[1], connection.cwd); return { code: 0, stdout: JSON.stringify(rows) }; };
  await runPanelReviewFiler(UP, pass.deps);
  await runPanelReviewFiler(UP, pass.deps);
  assert.equal(creates, 2, 'an invalidated review permits exactly one replacement');
  assert.equal(rows[1].id, 'shop-2');
  assert.equal(rows[1].metadata.noticeos_panel_version, VERSION);
  assert.equal(closes, 6);
  rows[1].labels.push('invalid-automation');
  await runPanelReviewFiler(UP, pass.deps);
  await runPanelReviewFiler(UP, pass.deps);
  assert.equal(creates, 3, 'invalidating the replacement permits one subsequent valid review');
  assert.equal(rows[2].id, 'shop-3');
  assert.equal(closes, 7);


  assert.equal(await fs.stat(path.join(root, '.beads')).catch(() => null), null);
});

/** A published panel's freshness.json whose DataForSEO source reaches `day`,
 * with each named family at that day. */
function published(asset, day, reports = []) {
  return {
    asset,
    sources: [{
      key: 'dataforseo', integration: 'dataforseo', collected: true, newestReportDate: day,
      reports: reports.map((report) => ({ report, newestReportDate: day })),
    }],
  };
}

function filer({ landings, existing = '[]', hub = true, panel = (asset) => published(asset, '2026-09-21') } = {}) {
  const ran = [];
  const asked = [];
  const lines = [];
  const deps = {
    probe: async () => hub,
    readConfig: async () => PROJECTS,
    readToken: async () => 'example-bearer',
    get: async (url, init) => {
      asked.push({ url, init });
      return new Response(JSON.stringify({ landings }), { status: 200 });
    },
    run: async (argv) => {
      ran.push(argv);
      return { code: 0, stdout: argv.includes('create') ? '{"id":"shop-1"}' : existing, stderr: '' };
    },
    readPublished: async (asset) => panel(asset),
    readVersion: async () => VERSION,
    state: { skipping: null, unmapped: new Set(), waiting: new Set() },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
  };
  deps.createReview = async (project, landing) => {
    const result = await deps.run(panelReviewCreateArgs(project.cwd ?? new URL('../shop', import.meta.url).pathname, landing));
    if (result.code !== 0) throw new Error('task client create failed');
    return JSON.parse(result.stdout).id;
  };
  return { deps, ran, asked, lines };
}

test('publication movement cannot change the version whose families the filer checked', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-review-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const newer = '00000005-2026-09-23T13-10-04-637Z-4f83dc';
  const asset = 'shop.example', reports = path.join(root, `${asset}.reports`);
  for (const version of [VERSION, newer]) {
    await fs.mkdir(path.join(reports, version), { recursive: true });
    await fs.writeFile(path.join(reports, version, 'freshness.json'), JSON.stringify(published(asset,
      version === VERSION ? '2026-09-21' : '2026-09-14', ['serp-panel'])));
  }
  const current = path.join(root, asset);
  await fs.symlink(path.join(reports, VERSION), current);
  const pinned = await readPublishedVersion(asset, root);
  await fs.unlink(current); await fs.symlink(path.join(reports, newer), current);
  assert.equal((await readPublishedFreshness(asset, pinned, root)).sources[0].newestReportDate, '2026-09-21');
  assert.equal((await readPublishedFreshness(asset, null, root)).sources[0].newestReportDate, '2026-09-14');
});

test('a missing, invalid or unreadable publication version files nothing until immutable evidence is available', async () => {
  for (const unavailable of [null, 'invalid', new Error('synthetic publication read failure')]) {
    const pass = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }] });
    let version = unavailable;
    const checkedVersions = [];
    pass.deps.readVersion = async () => {
      if (version instanceof Error) throw version;
      return version;
    };
    pass.deps.readPublished = async (asset, pinned) => {
      checkedVersions.push(pinned);
      return published(asset, '2026-09-21');
    };
    for (let poll = 0; poll < 2; poll++) {
      assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, []);
    }
    assert.deepEqual(checkedVersions, [], 'a mutable current publication cannot substitute for a version');
    assert.equal(pass.ran.some(argv => argv.includes('create')), false);
    assert.equal(pass.lines.length, 1, 'the same publication gap is reported once');
    version = VERSION;
    assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed,
      [{ asset: 'shop.example', panelDate: '2026-09-21', beadId: 'shop-1' }]);
    assert.deepEqual(checkedVersions, [VERSION]);
    const create = pass.ran.find(argv => argv.includes('create')).join(' ');
    assert.match(create, new RegExp(`"noticeos_panel_version":"${VERSION}"`, 'u'));
  }
});

test('an invalid task-list shape files nothing and leaves the next pass available', async () => {
  const pass = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }], existing: '{}' });
  const result = await runPanelReviewFiler(UP, pass.deps);
  assert.deepEqual(result, { checked: 0, filed: [] });
  assert.equal(pass.ran.length, 1);
  assert.match(pass.lines[0], /invalid task list; filing nothing/);
});

test('a review is identified by its metadata first and its title second', () => {
  assert.equal(panelReviewTitle('shop.example', '2026-09-21'), 'Triage the 2026-09-21 serp panel for shop.example');
  assert.equal(panelReviewTitle('shop.example', '2026-09-21', false), 'Triage the 2026-09-21 signal collection for shop.example');
  assert.equal(panelReviewDueDate('2026-09-21'), '2026-09-28');
  assert.equal(panelReviewDueDate('soon'), null);
  assert.equal(panelReviewPanelDate({ title: 'Triage the 2026-09-21 signal collection for shop.example' }), '2026-09-21');
  assert.equal(panelReviewPanelDate({ metadata: { noticeos_panel_date: '2026-09-14' }, title: 'anything' }), '2026-09-14');
});

test('a review marked invalid neither dedupes a new one nor shows on the board', () => {
  const rows = [
    { id: 'shop-1', status: 'closed', title: panelReviewTitle('shop.example', '2026-09-21'), labels: [PANEL_REVIEW_LABEL, INVALID_PANEL_REVIEW_LABEL] },
    { id: 'shop-2', status: 'open', title: panelReviewTitle('shop.example', '2026-09-14') },
  ];
  assert.equal(panelReviewAlreadyFiled(rows, '2026-09-21'), false);
  assert.equal(panelReviewAlreadyFiled(rows, '2026-09-14'), true);
  assert.equal(panelReviewEntry(rows).beadId, 'shop-2');
  assert.ok(panelReviewListArgs('/r').includes('open,in_progress,blocked,deferred,closed'), 'closed reviews count too');
});

test('a landing with no review files one bead, asked of this runner’s own door', async () => {
  const { deps, ran, asked } = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }] });
  const result = await runPanelReviewFiler(UP, deps);
  assert.equal(asked[0].url, serpPanelLandingsUrl(CONFIG));
  assert.deepEqual(result.filed, [{ asset: 'shop.example', panelDate: '2026-09-21', beadId: 'shop-1' }]);
  assert.deepEqual(ran.map((argv) => argv[2] === '--actor' ? argv[4] : argv[2]), ['list', 'create']);
  // The review names the panel version it was filed on, beside its identity.
  const create = ran[1].join(' ');
  assert.match(create, new RegExp(`"noticeos_panel_version":"${VERSION}"`, 'u'));
  assert.match(create, new RegExp(`get_panel asset=shop\\.example version=${VERSION}`, 'u'));
});

test('an already-filed landing files nothing, and a down hub asks nothing', async () => {
  const filed = JSON.stringify([{ id: 'shop-1', status: 'open', title: panelReviewTitle('shop.example', '2026-09-21') }]);
  const again = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }], existing: filed });
  assert.deepEqual((await runPanelReviewFiler(UP, again.deps)).filed, []);
  const down = filer({ landings: [], hub: false });
  assert.equal(await runPanelReviewFiler(UP, down.deps), null);
  assert.deepEqual([down.asked, down.ran], [[], []]);
  assert.match(down.lines[0], /the beads task hub is unreachable/u);
});

// The review points at the panel dir, so it waits until the
// published panel holds the collection it is about — said once, then filed.
test('a review waits for the published panel, then files', async () => {
  const landings = [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4, families: 2, reports: ['serp-panel', 'ranked-keywords'] }];
  let panel = () => null;
  const pass = filer({ landings, panel: (asset) => panel(asset) });

  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, []);
  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, []);
  assert.deepEqual(pass.ran.map((argv) => argv[2] === '--actor' ? argv[4] : argv[2]), ['list', 'list'], 'nothing created while unpublished');
  assert.deepEqual(pass.lines, [
    "WARN panel review: shop.example's 2026-09-21 collection waits for the panel refresh — " +
      'no panel has been published (silent until it is published)',
  ]);

  panel = (asset) => published(asset, '2026-09-21', ['ranked-keywords', 'serp-panel']);
  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, [
    { asset: 'shop.example', panelDate: '2026-09-21', beadId: 'shop-1' },
  ]);
});

test('a published panel holds a collection only when it holds every family of that day', () => {
  const landing = { asset: 'shop.example', panelDate: '2026-09-21', reports: ['serp-panel', 'ranked-keywords'] };
  const partial = published('shop.example', '2026-09-21', ['serp-panel']);
  partial.sources[0].reports.push({ report: 'ranked-keywords', newestReportDate: '2026-09-14' });
  assert.equal(panelPublicationGap(partial, landing), 'the published panel lacks ranked-keywords');
  assert.equal(
    panelPublicationGap(published('shop.example', '2026-09-14'), landing),
    "the published panel's DataForSEO reaches 2026-09-14",
  );
  assert.equal(
    panelPublicationGap({ asset: 'shop.example', sources: [] }, landing),
    "the published panel's DataForSEO reaches no day",
  );
  assert.equal(panelPublicationGap(published('other.example', '2026-09-21'), landing), "the published freshness.json is not this property's");
  // A landing or a panel written before families were named: the day decides.
  assert.equal(panelPublicationGap(published('shop.example', '2026-09-21'), { ...landing, reports: null }), null);
  const unnamed = published('shop.example', '2026-09-21');
  delete unnamed.sources[0].reports;
  assert.equal(panelPublicationGap(unnamed, landing), null);
});

test('an already-filed review is not held for its panel', async () => {
  const filed = JSON.stringify([{ id: 'shop-1', status: 'open', title: panelReviewTitle('shop.example', '2026-09-21') }]);
  const pass = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }], existing: filed, panel: () => null });
  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, []);
  assert.deepEqual(pass.lines, []);
});
