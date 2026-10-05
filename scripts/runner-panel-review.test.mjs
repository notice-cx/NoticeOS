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
  panelReviewTitle,
  runPanelReviewFiler,
  serpPanelLandingsUrl,
} from './runner/panel-review.mjs';

// scripts/runner/panel-review.mjs (bead ro-ujb9.22): the panel-review
// vocabulary and the filer that writes review beads. The filer is driven with
// a canned door and a recording `bd`; nothing reaches a real tracker.

const UP = { running: true, ready: true };
const PROJECTS = JSON.stringify({ spokes: [{ asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' }] });

function filer({ landings, existing = '[]', hub = true } = {}) {
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
    state: { skipping: null, unmapped: new Set() },
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

test('os-up.mjs still offers the same panel-review names', () => {
  assert.equal(osUp.runPanelReviewFiler, runPanelReviewFiler);
  assert.equal(osUp.panelReviewEntry, panelReviewEntry);
  assert.equal(osUp.panelReviewTitle, panelReviewTitle);
  assert.equal(osUp.PANEL_REVIEW_LABEL, PANEL_REVIEW_LABEL);
});
