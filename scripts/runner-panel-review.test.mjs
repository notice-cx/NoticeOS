import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import { CONFIG } from './runner/config.mjs';
import {
  INVALID_PANEL_REVIEW_LABEL,
  PANEL_REVIEW_LABEL,
  panelReviewAlreadyFiled,
  panelReviewDueDate,
  panelReviewEntry,
  panelReviewListArgs,
  panelReviewPanelDate,
  panelPublicationGap,
  panelReviewTitle,
  runPanelReviewFiler,
  serpPanelLandingsUrl,
} from './runner/panel-review.mjs';

// scripts/runner/panel-review.mjs: the panel-review
// vocabulary and the filer that writes review beads. The filer is driven with
// a canned door and a recording `bd`; nothing reaches a real tracker.

const UP = { running: true, ready: true };
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
    state: { skipping: null, unmapped: new Set(), waiting: new Set() },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
  };
  return { deps, ran, asked, lines };
}

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

test('os-up.mjs still offers the same panel-review names', () => {
  assert.equal(osUp.runPanelReviewFiler, runPanelReviewFiler);
  assert.equal(osUp.panelReviewEntry, panelReviewEntry);
  assert.equal(osUp.panelReviewTitle, panelReviewTitle);
  assert.equal(osUp.PANEL_REVIEW_LABEL, PANEL_REVIEW_LABEL);
});
