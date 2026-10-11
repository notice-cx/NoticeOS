// The part of `pnpm os:setup` that runs inside a one-off app container, on the
// stack's own network, so the host needs neither psql nor Beads: the frozen
// schema and one workspace on a database it proves empty, the NoticeOS asset,
// and the OS's own task project on the task server.
//
// deploy/compose/entrypoint.mjs runs it as the `setup` job with the app's
// environment. The owner's address arrives on stdin, never in an argument or
// the environment. It prints one JSON line, `{"asset": "<id>"}`, and nothing
// that holds a secret; any failure is one sentence on stderr and exit 1.
//
// It is the fresh-install exception (AGENTS.md): the database must be provably
// empty, and an existing task database or project refuses everything.

import * as fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOwnerFreshSchema, freshWorkspace, frozenBaseline, ownerDatabaseEmpty } from './start-postgres.mjs';
import { createFreshOsAsset } from './start-dolt.mjs';
import { BEADS_VERSION } from './dolt-project.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { runCommand } from './run-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The OS's own task project: its prefix, its database and its checkout under /spokes. */
export const TASK_PROJECT = Object.freeze({ prefix: 'no', database: 'noticeos_tasks', repo: '/spokes/noticeos' });
const STATE = '/state';
const HUB = Object.freeze({ host: 'dolt', port: 3306, user: 'noticeos' });

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

/** The password the task client keeps in its credentials file (`password=…`). */
function taskPassword(file) {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((row) => row.startsWith('password='));
  const password = line?.slice('password='.length).trim();
  if (!password || !/^[0-9a-f]{64}$/u.test(password)) refuse('the task client credentials are not in the expected form.');
  return password;
}

/** The frozen schema and one workspace, on a database proven empty. */
export function prepareDatabase(ownerUrl, { root = ROOT, empty = ownerDatabaseEmpty, apply = applyOwnerFreshSchema } = {}) {
  const marker = frozenBaseline(root);
  if (marker === null) refuse('the Postgres baseline in this image is not fully frozen; nothing was applied.');
  if (!empty(ownerUrl)) refuse('the database is not empty; setup applies nothing to an existing database.');
  if (!apply(ownerUrl, { workspace: freshWorkspace(undefined), dir: path.join(root, 'db', 'postgres', 'migrations'), frozen: marker })) refuse('the frozen schema or the workspace did not finish.');
}

/** The OS's task project in its own new checkout, bound to the stack's task server. */
export async function prepareTaskProject({ run = runCommand, env = process.env, project = TASK_PROJECT, state = STATE } = {}) {
  if (fs.lstatSync(project.repo, { throwIfNoEntry: false })) refuse(`${project.repo} already exists; setup never adopts a task project.`);
  const own = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  fs.mkdirSync(project.repo, { mode: 0o700 });
  const step = async (command, args, what, extra = {}) => {
    const result = await run(command, args, { cwd: project.repo, env: { ...own, ...extra }, timeoutMs: 90_000 });
    if (result.code !== 0) refuse(`${what} did not finish.`);
  };
  await step('git', ['init', '--quiet', '.'], 'the task repository');
  await step('git', ['config', '--local', 'user.name', 'NoticeOS'], 'the task repository');
  await step('git', ['config', '--local', 'user.email', 'noticeos@example.invalid'], 'the task repository');
  const password = taskPassword(path.join(state, 'dolt', 'credentials'));
  // Without IF NOT EXISTS: success proves this run made the database, so an
  // existing one refuses setup before Beads touches it.
  await step('dolt', [`--host=${HUB.host}`, `--port=${HUB.port}`, `--user=${HUB.user}`, '--no-tls', 'sql', '--query', `CREATE DATABASE \`${project.database}\``],
    'creating the task database (it may already exist)', { DOLT_CLI_PASSWORD: password });
  // Only these children get the password, and only in their environment.
  await step(env.BEADS_BD_BIN ?? 'bd', ['init', '--server', '--external', '--server-host', HUB.host, '--server-port', String(HUB.port),
    '--server-user', HUB.user, '--database', project.database, '--prefix', project.prefix,
    '--non-interactive', '--skip-hooks', '--skip-agents'], `Beads ${BEADS_VERSION} task initialization`,
  { BEADS_DOLT_PASSWORD: password });
  const config = path.join(project.repo, '.beads', 'config.yaml');
  const kept = fs.readFileSync(config, 'utf8').split('\n').filter((line) => !/^\s*(?:sync\.remote|no-git-ops|import\.auto|export\.auto)\s*:/u.test(line));
  fs.writeFileSync(config, `${kept.join('\n').trimEnd()}\nno-git-ops: true\nimport.auto: false\nexport.auto: false\n`, { mode: 0o600 });
}

/** The installation's own settings that name the OS asset and its task project. */
export function writeInstallationDocuments(asset, { root = ROOT, installation = path.join(STATE, 'installation'), project = TASK_PROJECT } = {}) {
  const product = (name) => JSON.parse(fs.readFileSync(path.join(root, 'config', name), 'utf8'));
  const integrations = product('integrations.json');
  const panels = product('signal-panels.json');
  for (const doc of [integrations, panels]) {
    if (!doc.assets || typeof doc.assets !== 'object' || Array.isArray(doc.assets) || Object.keys(doc.assets).length) refuse('the product roster is not empty.');
  }
  const documents = {
    'integrations.json': { ...integrations, assets: { [asset]: {} } },
    'signal-panels.json': { ...panels, assets: { [asset]: { enabled: false, reason: 'no-lane-yet', since: new Date().toISOString().slice(0, 10) } } },
    'beads.json': { version: 1, hub: { ...HUB, dataDir: path.join(STATE, 'dolt') }, spokes: [{ asset, prefix: project.prefix, database: project.database }] },
    'task-host.json': { version: 1, repositories: [{ asset, prefix: project.prefix, database: project.database, repo: project.repo }] },
  };
  for (const [name, body] of Object.entries(documents)) {
    fs.writeFileSync(path.join(installation, name), `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
}

export async function main({ input = process.stdin, out = process.stdout, err = process.stderr, env = process.env,
  database = prepareDatabase, tasks = prepareTaskProject, asset = createFreshOsAsset, documents = writeInstallationDocuments,
  bindings = () => JSON.parse(fs.readFileSync(path.join(STATE, 'workers', 'ingest', '.dev.secrets.json'), 'utf8')) } = {}) {
  try {
    const ownerUrl = await readStdin(input);
    if (!ownerUrl) refuse('no owner address arrived on stdin.');
    database(ownerUrl);
    await tasks({ env });
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
