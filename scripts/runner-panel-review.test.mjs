import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CONFIG } from './runner/config.mjs';
import {
  INVALID_PANEL_REVIEW_LABEL,
  PANEL_REVIEW_LABEL,
  panelReviewAlreadyFiled,
  panelReviewDueDate,
  panelReviewEntry,
  panelReviewPanelDate,
  panelPublicationGap,
  readPublishedFreshness,
  readPublishedVersion,
  panelReviewTitle,
  runPanelReviewFiler,
  serpPanelLandingsUrl,
} from './runner/panel-review.mjs';

// scripts/runner/panel-review.mjs: the panel-review vocabulary and the filer
// that files review tasks in Ntasks. The filer is driven with a canned door and
// a scripted Ntasks; nothing reaches a real tracker.

const UP = { running: true, ready: true };
const VERSION = '00000004-2026-09-22T13-10-04-637Z-4f83dc';
const PROJECTS = JSON.stringify({ spokes: [{ asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' }] });

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

/** An Ntasks holding the shop project's `tasks`: the label read answers them,
 * and a create files one more. */
function ntasks(tasks = []) {
  const state = { tasks: [...tasks], calls: [], creates: [] };
  const service = {
    backend: async () => 'ntasks',
    projects: async () => [{ projectId: 'p-shop', logicalKey: 'shop.example', displayName: 'Shop', prefix: 'shop' }],
    async call(call) {
      state.calls.push(call);
      const url = new URL(call.path, 'https://ntasks.example.com');
      if (call.method === 'GET' && url.searchParams.has('label')) {
        return { status: 200, body: { tasks: state.tasks.filter((task) => task.labels.includes(url.searchParams.get('label'))), next: null } };
      }
      if (call.method === 'POST' && url.pathname === '/api/tasks') {
        const id = `shop-${state.tasks.length + 1}`;
        state.creates.push(call.body);
        state.tasks.push({ id, status: 'open', title: call.body.title, labels: call.body.labels, metadata: call.body.metadata });
        return { status: 201, body: { id } };
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    },
  };
  return { service, state };
}

function filer({ landings, tasks = [], panel = (asset) => published(asset, '2026-09-21') } = {}) {
  const asked = [];
  const lines = [];
  const { service, state } = ntasks(tasks);
  const deps = {
    taskService: service,
    readConfig: async () => PROJECTS,
    readToken: async () => 'example-bearer',
    get: async (url, init) => {
      asked.push({ url, init });
      return new Response(JSON.stringify({ landings }), { status: 200 });
    },
    readPublished: async (asset) => panel(asset),
    readVersion: async () => VERSION,
    state: { skipping: null, unmapped: new Set(), waiting: new Set() },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
  };
  return { deps, ntasks: state, asked, lines };
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
    assert.deepEqual(pass.ntasks.creates, []);
    assert.equal(pass.lines.length, 1, 'the same publication gap is reported once');
    version = VERSION;
    assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed,
      [{ asset: 'shop.example', panelDate: '2026-09-21', taskId: 'shop-1' }]);
    assert.deepEqual(checkedVersions, [VERSION]);
    assert.equal(pass.ntasks.creates[0].metadata.noticeos_panel_version, VERSION);
  }
});

test('a review is identified by its metadata first and its title second', () => {
  for (const panel of [true, false]) {
    const title = panelReviewTitle('shop.example', '2026-09-21', panel);
    assert.ok(title.includes('shop.example'));
    assert.equal(panelReviewPanelDate({ title }), '2026-09-21');
  }
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
});

test('a landing with no review files one task, asked of this runner’s own door', async () => {
  const { deps, ntasks, asked } = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }] });
  const result = await runPanelReviewFiler(UP, deps);
  assert.equal(asked[0].url, serpPanelLandingsUrl(CONFIG));
  assert.deepEqual(result.filed, [{ asset: 'shop.example', panelDate: '2026-09-21', taskId: 'shop-1' }]);
  assert.deepEqual(ntasks.calls.map((call) => call.method), ['GET', 'POST']);
  // The review names the panel version it was filed on, beside its identity.
  const [create] = ntasks.creates;
  assert.equal(create.metadata.noticeos_panel_version, VERSION);
  assert.ok(create.description.includes(`get_panel asset=shop.example version=${VERSION}`));
});

// The review points at the panel dir, so it waits until the
// published panel holds the collection it is about — said once, then filed.
test('a review waits for the published panel, then files', async () => {
  const landings = [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4, families: 2, reports: ['serp-panel', 'ranked-keywords'] }];
  let panel = () => null;
  const pass = filer({ landings, panel: (asset) => panel(asset) });

  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, []);
  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, []);
  assert.deepEqual(pass.ntasks.creates, [], 'nothing created while unpublished');
  assert.equal(pass.lines.length, 1, 'repeated polls report the same publication gap once');
  assert.match(pass.lines[0], /^WARN /);
  assert.ok(pass.lines[0].includes('shop.example'));
  assert.ok(pass.lines[0].includes('2026-09-21'));

  panel = (asset) => published(asset, '2026-09-21', ['ranked-keywords', 'serp-panel']);
  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, [
    { asset: 'shop.example', panelDate: '2026-09-21', taskId: 'shop-1' },
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
  assert.equal(panelPublicationGap(published('other.example', '2026-09-21'), landing), "the published freshness.json is not this asset's");
  // A landing or a panel written before families were named: the day decides.
  assert.equal(panelPublicationGap(published('shop.example', '2026-09-21'), { ...landing, reports: null }), null);
  const unnamed = published('shop.example', '2026-09-21');
  delete unnamed.sources[0].reports;
  assert.equal(panelPublicationGap(unnamed, landing), null);
});

test('an already-filed review is not held for its panel', async () => {
  const filed = [{ id: 'shop-1', status: 'open', title: panelReviewTitle('shop.example', '2026-09-21'), labels: [PANEL_REVIEW_LABEL] }];
  const pass = filer({ landings: [{ asset: 'shop.example', panelDate: '2026-09-21', queries: 4 }], tasks: filed, panel: () => null });
  assert.deepEqual((await runPanelReviewFiler(UP, pass.deps)).filed, []);
  assert.deepEqual(pass.lines, []);
});
