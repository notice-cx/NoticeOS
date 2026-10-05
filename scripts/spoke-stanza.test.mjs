import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readablePath } from './installation.mjs';

// The spoke stanza — the beads safety armor every property repo's CLAUDE.md
// (and nom's AGENTS.md) duplicates on purpose, byte-identical, so the
// invariants survive an agent who never opens the contract. The canonical copy
// lives in config/beads.README.md between the markers; this test is what keeps
// seven copies from drifting (operator decision 2026-08-03: same-bytes stanzas
// plus a pointer, never symlinks — a symlink dangles off this machine).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = path.join(REPO_ROOT, 'config', 'beads.README.md');

function canonicalStanza() {
  const text = readFileSync(CONTRACT, 'utf8');
  const match = /<!-- spoke-stanza:begin -->\n([\s\S]*?)\n<!-- spoke-stanza:end -->/.exec(text);
  return match ? match[1] : null;
}

test('the contract carries the canonical stanza between its markers', () => {
  const stanza = canonicalStanza();
  assert.ok(stanza, 'markers missing or empty in config/beads.README.md');
  // The sentences that exist because an operator decided them — if a rewrite
  // loses one, that is a contract change, not a formatting change.
  assert.match(stanza, /ONLY task CLI/);
  assert.match(stanza, /Never start a private dolt server/);
  assert.match(stanza, /close the session their work lands/);
  assert.match(stanza, /`human`/);
});

test('every checked-out spoke carries the stanza byte-identical', (t) => {
  const stanza = canonicalStanza();
  assert.ok(stanza);
  const map = JSON.parse(readFileSync(readablePath('config/beads.json', { root: REPO_ROOT }), 'utf8'));
  let checked = 0;
  for (const spoke of map.spokes) {
    if (!spoke?.repo || spoke.repo === '.') continue;
    const repoDir = path.resolve(REPO_ROOT, spoke.repo);
    if (!existsSync(repoDir)) continue; // another machine; absence is not drift
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const file = path.join(repoDir, name);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      // Only files that carry a beads bullet list owe the canonical block —
      // an AGENTS.md with no beads section owes nothing.
      if (!text.includes('- `bd ready`')) continue;
      checked += 1;
      assert.ok(
        text.includes(stanza),
        `${spoke.asset}/${name} has drifted from the canonical spoke stanza — ` +
          're-stamp it from config/beads.README.md (spoke-stanza markers)',
      );
    }
  }
  if (checked === 0) {
    t.skip('no sibling spokes checked out — nothing to compare');
    return;
  }
});

test('every checked-out spoke carries a property-local freeze register', (t) => {
  const map = JSON.parse(readFileSync(readablePath('config/beads.json', { root: REPO_ROOT }), 'utf8'));
  let checked = 0;
  for (const spoke of map.spokes) {
    if (!spoke?.repo) continue;
    const repoDir = path.resolve(REPO_ROOT, spoke.repo);
    if (!existsSync(repoDir)) continue; // another machine; absence is not drift
    checked += 1;
    const file = path.join(repoDir, 'docs', 'freeze-register.md');
    assert.ok(
      existsSync(file),
      `${spoke.asset} is missing docs/freeze-register.md — omission means unknown, not clear`,
    );
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^# Freeze register$/m, `${spoke.asset} register needs its canonical title`);
    assert.match(text, /^## Active freezes$/m, `${spoke.asset} register needs active state`);
    assert.match(text, /^## Closed windows$/m, `${spoke.asset} register needs closed state`);
    assert.match(text, /readback/i, `${spoke.asset} register must route results to a readback`);
  }
  if (checked === 0) t.skip('no spokes checked out — nothing to compare');
});

test('no checked-out spoke maintains the retired bv bridge', (t) => {
  const map = JSON.parse(readFileSync(readablePath('config/beads.json', { root: REPO_ROOT }), 'utf8'));
  let checked = 0;
  for (const spoke of map.spokes) {
    if (!spoke?.repo) continue;
    const repoDir = path.resolve(REPO_ROOT, spoke.repo);
    if (!existsSync(repoDir)) continue;
    const config = readFileSync(path.join(repoDir, '.beads', 'config.yaml'), 'utf8');
    checked += 1;
    assert.doesNotMatch(
      config,
      /^export:\s*\n\s+auto:\s*true/m,
      `${spoke.asset} still auto-exports the retired viewer cache`,
    );
    assert.doesNotMatch(
      config,
      /bv viewer bridge/i,
      `${spoke.asset} still documents the retired viewer bridge`,
    );
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const file = path.join(repoDir, name);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        text,
        /bv-agent-instructions/,
        `${spoke.asset}/${name} still carries bv's injected instruction block`,
      );
    }
  }
  if (checked === 0) t.skip('no spokes checked out — nothing to compare');
});
