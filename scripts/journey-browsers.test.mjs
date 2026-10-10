import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JOURNEY_BROWSERS } from '../apps/tower/e2e/journey-browsers.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';

// The journey browser install puts Chromium where the journeys look, from any
// checkout or worktree. A relative PLAYWRIGHT_BROWSERS_PATH is resolved by
// Playwright against INIT_CWD (the folder pnpm was started in), so run from
// the checkout root it would write Chromium two folders above the checkout
// while the journeys read an absolute path
// inside it. Now one module (apps/tower/e2e/journey-browsers.mjs) names the
// folder from its own place in the checkout, and the install, the browser
// suite and the flow gate all take it from there. The install is proved with
// Playwright's own --dry-run, which prints each install location and
// downloads nothing (Chromium is about 370 MB).

const TOWER = path.join(REPO_ROOT, 'apps', 'tower');
const INSTALL = path.join(TOWER, 'e2e', 'install-browser.mjs');
const EXPECTED = path.join(REPO_ROOT, 'node_modules', '.cache', 'journey-playwright');

test("the journeys' browsers live in this checkout's node_modules/.cache/journey-playwright", () => {
  assert.equal(JOURNEY_BROWSERS, EXPECTED);
});

test('the install puts every browser there whether pnpm was started at the checkout root, in the Tower or elsewhere, even with a stale relative path set', () => {
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'journey-install-'));
  try {
    for (const started of [REPO_ROOT, TOWER, elsewhere]) {
      // pnpm sets INIT_CWD to the folder it was started in; a relative path is
      // left in the environment to show it does not count.
      const result = spawnSync(process.execPath, [INSTALL, '--dry-run'], {
        cwd: started,
        env: { ...process.env, INIT_CWD: started, PLAYWRIGHT_BROWSERS_PATH: '../../node_modules/.cache/journey-playwright' },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${started}: ${result.stderr}`);
      assert.ok(result.stdout.split('\n').includes(`Journey browsers: ${EXPECTED}`), `${started}: the install says where\n${result.stdout}`);
      const locations = [...result.stdout.matchAll(/^\s*Install location:\s+(.+?)\s*$/gmu)].map((match) => match[1]);
      assert.ok(locations.some((location) => path.basename(location).startsWith('chromium')), `${started}: Chromium is among them\n${result.stdout}`);
      for (const location of locations) assert.equal(path.dirname(location), EXPECTED, `${started}: ${location}`);
    }
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('the install, the browser suite and the UX flow gate take the folder from that one module', () => {
  const tower = JSON.parse(readFileSync(path.join(TOWER, 'package.json'), 'utf8'));
  assert.equal(tower.scripts['journey:install'], 'node e2e/install-browser.mjs');
  for (const file of ['e2e/install-browser.mjs', 'e2e/playwright.config.ts', 'e2e/flow-gate.mjs']) {
    const code = readFileSync(path.join(TOWER, file), 'utf8');
    assert.match(code, /^import \{ JOURNEY_BROWSERS \} from "\.\/journey-browsers\.mjs";$/mu, file);
    assert.equal(code.includes('journey-playwright'), false, `${file} spells the folder itself`);
  }
});
