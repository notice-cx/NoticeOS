// A fresh clone seeds an EMPTY installation (bead ro-ujb9.125, D30, D33).
//
// The public repository carries config/ — the product's generic defaults —
// and no installation folder. This runs the real `pnpm config:seed` read path
// over the real defaults with an empty installation folder and proves what a
// stranger's store starts with: no sites, no task projects, no host links, no
// costs, and UTC. The neutral-code gate keeps the defaults that way
// (scripts/neutral-code-gate.mjs); this proves the seed a clone would send.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { INSTALLATION_DIR_ENV } from './installation.mjs';
import { CONFIG_DOCUMENT_FILES } from './config-documents.mjs';
import { runSeed } from './config-seed.mjs';
import { readTaskHost } from './task-project-config.mjs';
import { hostBackupFile, readOffsiteBackupDir } from './host-backup.mjs';
import { installationNames, isTimeZoneName } from './neutral-code-gate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A clone with no installation folder: the variable points at an empty one. */
async function freshClone(t) {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-installation-'));
  const before = process.env[INSTALLATION_DIR_ENV];
  process.env[INSTALLATION_DIR_ENV] = empty;
  t.after(async () => {
    if (before === undefined) delete process.env[INSTALLATION_DIR_ENV];
    else process.env[INSTALLATION_DIR_ENV] = before;
    await fs.rm(empty, { recursive: true, force: true });
  });
  return empty;
}

/** What `pnpm config:seed` would send the store, captured at the door. */
async function seededDocuments() {
  let sent = null;
  const { absent } = await runSeed({
    repoRoot: REPO_ROOT,
    token: 'synthetic-test-only',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ ok: true, seeded: [], skipped: [], refused: [] });
    },
  });
  assert.deepEqual(absent, [], 'every document has a product default');
  return sent.documents;
}

test('a fresh clone seeds every document from the product defaults, and none names a site', async (t) => {
  await freshClone(t);
  const docs = await seededDocuments();
  assert.deepEqual(Object.keys(docs).sort(), [...CONFIG_DOCUMENT_FILES].sort());

  // No sites, anywhere a site could be named.
  assert.deepEqual(docs['config/integrations.json'].assets, {});
  assert.ok(docs['config/integrations.json'].catalog.length > 0, 'the data-source catalog ships');
  assert.deepEqual(docs['config/pull.json'], []);
  assert.deepEqual(docs['config/counters.json'].assets, {});
  assert.deepEqual(docs['config/serp-panel.json'].assets, {});
  assert.deepEqual(docs['config/signal-panels.json'].assets, {});
  assert.deepEqual(docs['config/value-events.json'].assets, {});
  assert.deepEqual(docs['config/ga4-custom-dimensions.json'].assets, {});
  assert.deepEqual(docs['config/domain-costs.json'].domains, []);
  assert.deepEqual(docs['config/recurring-costs.json'].costs, []);
  assert.deepEqual(docs['config/entities.json'].entities, []);
  // No task projects; the local hub connection is the product's.
  assert.deepEqual(docs['config/beads.json'].spokes, []);
  assert.equal(docs['config/beads.json'].hub.host, '127.0.0.1');
  // Nothing declared about a site's reports, and no countdown.
  assert.equal('no_nightly_report' in docs['config/constants.json'], false);
  assert.equal('countdown' in docs['config/tower.json'], false);
});

test('a fresh clone\'s clock is UTC until the operator sets one', async (t) => {
  await freshClone(t);
  const constants = (await seededDocuments())['config/constants.json'];
  assert.equal(constants.os_time_zone, 'UTC');
  assert.ok(isTimeZoneName(constants.os_time_zone));
});

test('a fresh clone links no task checkout and owns no site name', async (t) => {
  await freshClone(t);
  assert.deepEqual(await readTaskHost({ repoRoot: REPO_ROOT }), { repositories: [] });
  // Neither product defaults nor the frozen Postgres schema seed a site's
  // identity. The installation inventory is absent in this fixture.
  const fromDocuments = [...installationNames(REPO_ROOT).values()].filter((entry) => !entry.source.startsWith('db/'));
  assert.deepEqual(fromDocuments, []);
});

// Bead ro-ujb9.120: the offsite backup folder is a host setting; a clone ships
// none, so a stranger's runner never copies its backups into somebody else's.
test('a fresh clone copies its backups to no offsite folder', async (t) => {
  await freshClone(t);
  assert.equal(hostBackupFile(REPO_ROOT), path.join(REPO_ROOT, 'config', 'host-backup.json'));
  assert.equal(await readOffsiteBackupDir({ repoRoot: REPO_ROOT }), null);
});
