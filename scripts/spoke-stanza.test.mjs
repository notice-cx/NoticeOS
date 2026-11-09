import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
function checkedOutSpokes() {
  const map = JSON.parse(readFileSync(readablePath('config/beads.json', { root: REPO_ROOT }), 'utf8'));
  return map.spokes
    .filter((spoke) => spoke?.repo && spoke.repo !== '.')
    .map((spoke) => ({ asset: spoke.asset, dir: path.resolve(REPO_ROOT, spoke.repo) }))
    .filter(({ dir }) => existsSync(dir));
}

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
