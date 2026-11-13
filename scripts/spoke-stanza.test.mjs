import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readablePath } from './installation.mjs';

// The spoke stanza: the pointer every project repo's CLAUDE.md (and its
// AGENTS.md) carries, byte-identical, to the task rules the MCP servers return
// (get_task_guide). The canonical copy lives in config/beads.README.md between
// the markers; these tests keep the copies from drifting and the retired task
// files out of the checkouts.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = path.join(REPO_ROOT, 'config', 'beads.README.md');
const RETIRED_TASK_FILES = ['.beads', '.beads.gate.lock'];
// An AGENTS.md carries task instructions when it holds the stanza's markers,
// names the task guide, or names a task CLI (bd, bv or br) or a .beads file.
// CLAUDE.md always owes the stanza.
function carriesTaskInstructions(text) {
  return (
    text.includes('<!-- spoke-stanza:begin -->') ||
    text.includes('get_task_guide') ||
    text.includes('.beads') ||
    /`(?:bd|bv|br)`|\b(?:bd|bv|br) (?:ready|list|show|create|update|close)\b/.test(text)
  );
}

function canonicalStanza() {
  const text = readFileSync(CONTRACT, 'utf8');
  const match = /<!-- spoke-stanza:begin -->\n([\s\S]*?)\n<!-- spoke-stanza:end -->/.exec(text);
  return match ? match[1] : null;
}

// The installation's task projects with a checkout on this machine. A project
// whose checkout is elsewhere is skipped: absence is not drift.
// Set NOTICEOS_SPOKE_CHECKOUT_PARENT to the directory holding moved checkouts.
function checkedOutSpokes(
  map = JSON.parse(readFileSync(readablePath('config/beads.json', { root: REPO_ROOT }), 'utf8')),
  root = REPO_ROOT,
  checkoutParent = process.env.NOTICEOS_SPOKE_CHECKOUT_PARENT,
) {
  return map.spokes
    .filter((spoke) => spoke?.repo && spoke.repo !== '.')
    .map((spoke) => {
      const repo = path.resolve(root, spoke.repo);
      const dir = checkoutParent && !path.isAbsolute(spoke.repo)
        ? path.resolve(checkoutParent, path.basename(repo))
        : repo;
      return { asset: spoke.asset, dir };
    })
    .filter(({ dir }) => existsSync(dir));
}

test('an explicit checkout parent resolves moved relative checkouts and preserves absolute ones', (t) => {
  const owned = mkdtempSync(path.join(tmpdir(), 'noticeos-spoke-stanza-'));
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  const root = path.join(owned, 'nested', 'noticeos');
  const checkouts = path.join(owned, 'sites');
  const moved = path.join(checkouts, 'moved');
  const absolute = path.join(owned, 'absolute');
  for (const dir of [root, moved, absolute]) mkdirSync(dir, { recursive: true });
  const map = { spokes: [
    { asset: 'moved.example', repo: '../moved' },
    { asset: 'absolute.example', repo: absolute },
    { asset: 'elsewhere.example', repo: '../elsewhere' },
    { asset: 'self.example', repo: '.' },
  ] };
  assert.deepEqual(checkedOutSpokes(map, root, checkouts), [
    { asset: 'moved.example', dir: moved },
    { asset: 'absolute.example', dir: absolute },
  ]);
});

test('the contract carries the canonical stanza between its markers', () => {
  assert.ok(canonicalStanza(), 'markers missing or empty in config/beads.README.md');
});

test('every checked-out spoke carries the stanza byte-identical', (t) => {
  const stanza = canonicalStanza();
  assert.ok(stanza);
  let checked = 0;
  for (const { asset, dir } of checkedOutSpokes()) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      // bv injected its own block outside the stanza; project preparation
      // leaves it in place.
      assert.doesNotMatch(text, /bv-agent-instructions/, `${asset}/${name} still carries bv's injected instruction block`);
      // An AGENTS.md that only points at CLAUDE.md owes nothing.
      if (name === 'AGENTS.md' && !carriesTaskInstructions(text)) continue;
      checked += 1;
      assert.ok(
        text.includes(stanza),
        `${asset}/${name} differs from the canonical spoke stanza; ` +
          're-stamp it from config/beads.README.md (spoke-stanza markers)',
      );
    }
  }
  if (checked === 0) t.skip('no checked-out spoke carries task instructions');
});

test('no checked-out spoke keeps the retired task files', (t) => {
  const spokes = checkedOutSpokes();
  if (spokes.length === 0) {
    t.skip('no spokes checked out');
    return;
  }
  for (const { asset, dir } of spokes) {
    for (const name of RETIRED_TASK_FILES) {
      assert.ok(!existsSync(path.join(dir, name)), `${asset} still holds ${name}`);
    }
    const ignore = path.join(dir, '.gitignore');
    if (!existsSync(ignore)) continue;
    const lines = readFileSync(ignore, 'utf8').split('\n').filter((line) => line.includes('.beads'));
    assert.deepEqual(lines, [], `${asset}/.gitignore still ignores task files`);
  }
});
