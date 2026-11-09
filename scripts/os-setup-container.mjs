// The part of `pnpm os:setup` that runs inside a one-off app container, on the
// stack's own network, so the host needs no psql: the frozen schema and one
// workspace on a database it proves empty, and the System asset.
//
// deploy/compose/entrypoint.mjs runs it as the `setup` job with the app's
// environment. The owner's address arrives on stdin, never in an argument or
// the environment. It prints one JSON line, `{"asset": "<id>"}`, and nothing
// that holds a secret; any failure is one sentence on stderr and exit 1.
//
// It is the fresh-install exception (AGENTS.md): the database must be provably
// empty, and an existing asset refuses everything.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../packages/postgres/src/store.mjs';
import { applyOwnerFreshSchema, freshWorkspace, frozenBaseline, ownerDatabaseEmpty } from './start-postgres.mjs';
import { invokedDirectly } from './invoked-directly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = '/state';

class SetupRefused extends Error {}
const refuse = (line) => { throw new SetupRefused(line); };

function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { text += chunk; if (text.length > 4096) reject(new SetupRefused('the owner address is too long.')); });
    stream.on('end', () => resolve(text.trim()));
    stream.on('error', reject);
  });
}

/** The frozen schema and one workspace, on a database proven empty. */
export function prepareDatabase(ownerUrl, { root = ROOT, empty = ownerDatabaseEmpty, apply = applyOwnerFreshSchema } = {}) {
  const marker = frozenBaseline(root);
  if (marker === null) refuse('the Postgres baseline in this image is not fully frozen; nothing was applied.');
  if (!empty(ownerUrl)) refuse('the database is not empty; setup applies nothing to an existing database.');
  if (!apply(ownerUrl, { workspace: freshWorkspace(undefined), dir: path.join(root, 'db', 'postgres', 'migrations'), frozen: marker })) refuse('the frozen schema or the workspace did not finish.');
}

/** The System asset (`is_os`), the first and only asset of a new installation. */
export async function createFreshOsAsset(address, { store = openStore, id = `os-${randomBytes(8).toString('hex')}` } = {}) {
  const db = store(address);
  try {
    const workspace = await db.onlyWorkspace();
    await db.inWorkspace(workspace, async tx => {
      if ((await tx.query('SELECT asset_id FROM noticeos.assets')).length) throw new Error('Fresh installation already has assets.');
      // Screens call this row SYSTEM_NAME (packages/contract/src/asset-name.mts)
      // whatever it stores; storing the same name keeps a raw read in step.
      await tx.execute(`INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, is_os)
        VALUES ($1, $2, NULL, 'System', 'live', true)`, [workspace, id]);
    });
    return id;
  } finally { await db.close(); }
}

/** The installation's own settings that name the System asset. */
export function writeInstallationDocuments(asset, { root = ROOT, installation = path.join(STATE, 'installation') } = {}) {
  const product = (name) => JSON.parse(fs.readFileSync(path.join(root, 'config', name), 'utf8'));
  const integrations = product('integrations.json');
  const panels = product('signal-panels.json');
  for (const doc of [integrations, panels]) {
    if (!doc.assets || typeof doc.assets !== 'object' || Array.isArray(doc.assets) || Object.keys(doc.assets).length) refuse('the product roster is not empty.');
  }
  const documents = {
    'integrations.json': { ...integrations, assets: { [asset]: {} } },
    'signal-panels.json': { ...panels, assets: { [asset]: { enabled: false, reason: 'no-lane-yet', since: new Date().toISOString().slice(0, 10) } } },
  };
  for (const [name, body] of Object.entries(documents)) {
    fs.writeFileSync(path.join(installation, name), `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
}

export async function main({ input = process.stdin, out = process.stdout, err = process.stderr,
  database = prepareDatabase, asset = createFreshOsAsset, documents = writeInstallationDocuments,
  bindings = () => JSON.parse(fs.readFileSync(path.join(STATE, 'workers', 'ingest', '.dev.secrets.json'), 'utf8')) } = {}) {
  try {
    const ownerUrl = await readStdin(input);
    if (!ownerUrl) refuse('no owner address arrived on stdin.');
    database(ownerUrl);
    const id = await asset(bindings().DATABASE_URL);
    documents(id);
    out.write(`${JSON.stringify({ asset: id })}\n`);
    return 0;
  } catch (error) {
    // Driver and tool errors can repeat an address; only a refusal's own sentence is shown.
    err.write(`setup refused: ${error instanceof SetupRefused ? error.message : 'a step failed; the installation was left as it is for inspection.'}\n`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
