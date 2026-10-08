// Read the custody of one completed synthetic generation, without setup authority.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateDemoScenario, demoScenarioHash } from './demo-scenario.mjs';
import { demoIntegrationAssets, generateDemoDisplay } from './demo-display.mjs';
import { readDoltProfile, readDoltCredentials, startDoltPlan, type DoltProfile } from './dolt-profile.mjs';
import { validateDemoViewer, type DemoViewerDescriptor } from './demo-viewer-policy.mjs';
import { PRODUCT_ENV } from './product-env.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const GENERATION_KEYS = ['completedAt', 'evaluator', 'manifestSha256', 'release', 'scenarioHash', 'synthetic', 'tasksSha256', 'tree', 'version', 'workspaceId'];
type Row = Record<string, unknown>;
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The completed demo custody is invalid.');
  return value as Row;
}
function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function same(actual: unknown, expected: unknown): boolean { return stable(actual) === stable(expected); }
function privateFile(home: string, relative: string): Buffer {
  const file = path.join(home, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > MAX_BYTES
    || fs.realpathSync(file) !== file) throw new Error('Demo custody needs private, bounded regular files.');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_BYTES || (opened.mode & 0o077)) {
      throw new Error('Demo custody changed while it was read.');
    }
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > MAX_BYTES) throw new Error('Demo custody exceeds its read limit.');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function json(bytes: Buffer): Row { return record(JSON.parse(bytes.toString('utf8'))); }
function artifactMap(value: unknown): boolean {
  const row = record(value);
  return Object.keys(row).length > 0 && Object.values(row).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash));
}
function freezeDocument<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDocument(child);
    Object.freeze(value);
  }
  return value;
}

export interface DemoViewerInstallation {
  readonly home: string;
  readonly viewer: Readonly<DemoViewerDescriptor>;
  readonly tree: string;
  readonly postgresProject: string;
  readonly postgresPort: number;
  /** The application address stays in private custody, never a receipt or argv. */
  readonly databaseFile: string;
  readonly dolt: Readonly<DoltProfile>;
  readonly projects: readonly Readonly<{ asset: string; prefix: string; database: string; repo: string }>[];
  readonly assetIds: readonly string[];
  readonly client: Readonly<{ version: string; sha256: string }>;
  readonly display: ReturnType<typeof generateDemoDisplay>;
  readonly integrations: ReturnType<typeof demoIntegrationAssets>;
}

/** File validation only. The launcher must separately prove exact resource and
 * read-only store identity before it starts a viewer. No defaults are accepted. */
export function readDemoViewerInstallation({ root, home, release, tree, now = Date.now() }: {
  root: string; home: string; release: string; tree: string; now?: number;
}): Readonly<DemoViewerInstallation> {
  if (!path.isAbsolute(root) || !path.isAbsolute(home) || fs.realpathSync(root) !== root || fs.realpathSync(home) !== home
    || !fs.lstatSync(home).isDirectory() || !/^[a-f0-9]{40}$/u.test(release) || !/^[a-f0-9]{40}$/u.test(tree)
    || !Number.isFinite(now)) throw new Error('Name a canonical completed demo and exact release.');
  const sourceRelative = path.relative(home, root);
  if (!sourceRelative || (!sourceRelative.startsWith('..') && !path.isAbsolute(sourceRelative))) throw new Error('The viewer needs a folder separate from its source.');
  for (const privateRoot of ['installation', '.beads', '.local']) {
    const relative = path.relative(path.join(root, privateRoot), home);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('The viewer refuses an installation-owned folder.');
  }
  const generation = json(privateFile(home, 'demo-generation.json'));
  const manifestBytes = privateFile(home, 'demo-manifest.json');
  const taskBytes = privateFile(home, 'demo-tasks.json');
  const manifest = json(manifestBytes);
  const tasks = json(taskBytes);
  const client = record(tasks.client);
  if (Object.keys(client).sort().join() !== 'sha256,version' || typeof client.version !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(client.version) || typeof client.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(client.sha256)) {
    throw new Error('The demo task executable custody is invalid.');
  }
  if (Object.keys(generation).sort().join() !== GENERATION_KEYS.join() || generation.version !== 1 || generation.synthetic !== true
    || generation.release !== release || generation.tree !== tree || generation.manifestSha256 !== digest(manifestBytes)
    || generation.tasksSha256 !== digest(taskBytes) || manifest.release !== release || manifest.synthetic !== true
    || manifest.home !== home || generation.workspaceId !== manifest.workspaceId || generation.scenarioHash !== manifest.scenarioHash
    || !same(generation.evaluator, manifest.evaluator)) throw new Error('The demo completion receipt does not match its held generation.');
  const evaluator = record(generation.evaluator);
  const workers = record(evaluator.workers);
  if (evaluator.release !== release || evaluator.tree !== tree || !artifactMap(evaluator.artifacts)
    || typeof workers.compiler !== 'string' || !artifactMap(workers.inputs) || !artifactMap(workers.artifacts)) {
    throw new Error('The demo evaluator provenance is incomplete.');
  }
  if (Object.keys(record(evaluator.artifacts)).sort().join() !== 'poisson.js,rules.js'
    || Object.keys(record(workers.artifacts)).sort().join() !== 'configuration,jobs,reports,snapshots,watch') {
    throw new Error('The demo evaluator artifacts are incomplete.');
  }
  for (const [input, hash] of Object.entries(record(workers.inputs))) {
    const source = input.replace(/ with \{ type: 'json' \}$/u, '');
    const file = path.resolve(root, source);
    if (path.isAbsolute(source) || path.relative(root, file).startsWith('..') || fs.realpathSync(file) !== file
      || digest(fs.readFileSync(file)) !== hash) throw new Error('The demo evaluator source differs from this release.');
  }
  const viewer = validateDemoViewer({ version: 1, synthetic: true, release, scenarioHash: manifest.scenarioHash,
    workspaceId: manifest.workspaceId, cutoff: manifest.cutoff, generatedAt: generation.completedAt });
  if (viewer.generatedAt === null || Date.parse(viewer.generatedAt) > now || Date.parse(viewer.cutoff) > Date.parse(viewer.generatedAt)) {
    throw new Error('The demo generation time is invalid.');
  }
  const scenario = generateDemoScenario({ seed: manifest.seed as string, cutoff: viewer.cutoff, release, timeZone: manifest.timeZone as string });
  if (demoScenarioHash(scenario) !== viewer.scenarioHash || Object.entries(scenario.manifest).some(([key, value]) => !same(manifest[key], value))) {
    throw new Error('The demo facts differ from their released scenario.');
  }
  const schema = record(manifest.schema);
  if (schema.frozenSha256 !== digest(fs.readFileSync(path.join(root, 'db/postgres/frozen-migrations.sha256')))) {
    throw new Error('The demo schema receipt differs from this release.');
  }
  const counts = record(manifest.counts);
  if (counts.watchStatus !== 'closed' || counts.tasks !== scenario.tasks.length || !Number.isInteger(counts.taskSnapshots)
    || Number(counts.taskSnapshots) < 1) throw new Error('The demo components did not all complete.');
  const display = generateDemoDisplay(scenario);
  const displayReceipt = record(manifest.display);
  if (!same(displayReceipt.documents, display) || !same(displayReceipt.files, Object.keys(display))
    || Object.entries(display).some(([file, body]) => !same(json(privateFile(home, `installation/${path.basename(file)}`)), body))) {
    throw new Error('The saved demo display differs from its scenario.');
  }
  const osReport = record(manifest.osReport);
  const observed = ['pulsesReceived', 'ledgerRows', 'openFlagsError', 'openFlagsWarn', 'openFlagsInfo'];
  if (osReport.synthetic !== true || osReport.generatedAt !== viewer.cutoff || osReport.asset !== scenario.assets.find(asset => asset.isOs)?.id
    || !same(osReport.capabilities, observed) || Object.keys(record(osReport.metrics)).sort().join() !== [...observed].sort().join()
    || counts.pulses !== scenario.pulses.length + 1) throw new Error('The synthetic OS observation is incomplete.');
  const history = record(manifest.workflowHistory);
  const files = record(history.files), mirror = record(history.mirror);
  if (history.version !== 1 || history.synthetic !== true || history.scenarioHash !== viewer.scenarioHash
    || Object.keys(files).sort().join() !== '.local/logs/job-runs.jsonl,.local/logs/workflow-runs.jsonl'
    || mirror.ok !== true || !Number.isSafeInteger(mirror.created) || Number(mirror.created) < 1
    || mirror.duplicate !== 0 || mirror.stale !== 0 || mirror.pruned !== 0
    || Object.entries(files).some(([file, hash]) => digest(privateFile(home, file)) !== hash)) {
    throw new Error('The demo workflow custody is incomplete or changed.');
  }
  const dolt = readDoltProfile(home);
  if (!dolt || !same(dolt, startDoltPlan({ root, home, port: dolt.port - 3 }))) throw new Error('The demo task profile differs from its owned folder.');
  for (const file of ['dolt/profile.json', 'dolt/credentials', 'dolt/secrets/root', 'dolt/secrets/noticeos']) privateFile(home, file);
  readDoltCredentials(dolt);
  const projects = scenario.manifest.taskProjects.map(project => Object.freeze({ ...project, repo: path.join(home, 'tasks', project.prefix) }));
  const host = json(privateFile(home, 'installation/task-host.json'));
  const beads = json(privateFile(home, 'installation/beads.json'));
  const integrations = json(privateFile(home, 'installation/integrations.json'));
  if (tasks.version !== 1 || tasks.synthetic !== true || tasks.release !== release || tasks.project !== dolt.project
    || tasks.scenarioHash !== viewer.scenarioHash || tasks.workspaceId !== viewer.workspaceId
    || tasks.tasks !== scenario.tasks.length || tasks.snapshots !== counts.taskSnapshots || !same(tasks.projects, projects)
    || !same(manifest.taskGeneration, tasks) || host.version !== 1 || !same(host.repositories, projects)
    || !same(beads.spokes, scenario.manifest.taskProjects)
    || !same(integrations.assets, demoIntegrationAssets(scenario))) {
    throw new Error('The demo task or provider roster differs from its scenario.');
  }
  for (const project of projects) {
    if (fs.realpathSync(project.repo) !== project.repo || !fs.lstatSync(project.repo).isDirectory()) throw new Error('A demo task repository left its owned folder.');
  }
  const databaseFile = path.join(home, 'postgres/secrets/database.url');
  const address = new URL(privateFile(home, 'postgres/secrets/database.url').toString('utf8').trim());
  const postgresPort = dolt.port - 1;
  if (postgresPort < 1024 || [3306, 3307, 3308, 4747, 5173, 5432, 8791].includes(postgresPort)) throw new Error('The demo refuses a reserved database port.');
  if (address.protocol !== 'postgresql:' || address.hostname !== '127.0.0.1' || Number(address.port) !== postgresPort
    || address.username !== 'noticeos_app' || !address.password || address.pathname !== '/noticeos' || address.hash
    || address.search !== '?sslmode=disable' || manifest.postgresProject !== dolt.project) {
    throw new Error('The demo application address differs from its owned profile.');
  }
  return Object.freeze({ home, viewer, tree, postgresProject: dolt.project, postgresPort, databaseFile,
    dolt: Object.freeze(dolt), projects: Object.freeze(projects), assetIds: Object.freeze(scenario.assets.map(asset => asset.id)),
    client: Object.freeze({ version: client.version, sha256: client.sha256 }), display: freezeDocument(display),
    integrations: freezeDocument(demoIntegrationAssets(scenario)) });
}

export interface DemoViewerLaunch {
  readonly installation: Readonly<DemoViewerInstallation>;
  readonly runtime: string;
  readonly towerPort: number;
  readonly doorPort: number;
}
/** The Vite configuration accepts only a launch declaration that still matches
 * completed custody and every local runtime binding. Ordinary installs do no IO. */
export function readDemoViewerLaunch(root: string, env: Readonly<Record<string, string | undefined>> = process.env): Readonly<DemoViewerLaunch> | null {
  const file = env.NOTICEOS_DEMO_VIEWER_FILE;
  if (file === undefined) return null;
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('The demo launch declaration is invalid.');
  const declaration = json(privateFile(path.dirname(file), path.basename(file)));
  const viewer = validateDemoViewer(declaration.viewer);
  if (Object.keys(declaration).sort().join() !== 'doorPort,home,root,runtime,towerPort,tree,version,viewer'
    || declaration.version !== 1 || declaration.root !== root || typeof declaration.home !== 'string'
    || typeof declaration.tree !== 'string' || typeof declaration.runtime !== 'string'
    || path.dirname(declaration.runtime) !== path.join(declaration.home, 'viewers')
    || !/^viewer-[a-zA-Z0-9]{6}$/u.test(path.basename(declaration.runtime))
    || fs.realpathSync(declaration.runtime) !== declaration.runtime || file !== path.join(declaration.runtime, 'viewer.json')) {
    throw new Error('The demo launch declaration is invalid.');
  }
  const installation = readDemoViewerInstallation({ root, home: declaration.home, release: viewer.release, tree: declaration.tree });
  if (!same(installation.viewer, viewer)) throw new Error('The demo launch no longer matches its generation.');
  const ports = [declaration.towerPort, declaration.doorPort];
  if (ports.some(port => typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535
    || [3306, 3307, 3308, 4747, 5173, 5432, 8791, installation.postgresPort, installation.dolt.port].includes(port))
    || new Set(ports).size !== 2) throw new Error('The demo viewer needs two distinct local ports.');
  const expected: Record<string, string> = {
    NOTICEOS_HOME: installation.home, NOTICEOS_INSTALLATION_DIR: path.join(installation.home, 'installation'),
    NOTICEOS_DOLT_HOME: installation.home, NOTICEOS_WORKER_CONFIG_ROOT: declaration.runtime,
    OS_UP_PERSIST_STATE: path.join(declaration.runtime, 'state'), OS_UP_INGEST_DOOR_HOST: '127.0.0.1',
    OS_UP_INGEST_DOOR_PORT: String(declaration.doorPort), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES: privateFile(installation.home, 'postgres/secrets/database.url').toString('utf8').trim(),
  };
  if (Object.entries(expected).some(([key, value]) => env[key] !== value)
    || ['CLOUDFLARE_ENV', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES',
      'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN',
      'NODE_OPTIONS', 'DATABASE_URL', PRODUCT_ENV.home.legacy, PRODUCT_ENV.workerConfigRoot.legacy, PRODUCT_ENV.installationDir.legacy].some(key => env[key] !== undefined)) {
    throw new Error('The demo launch refuses inherited or mismatched runtime bindings.');
  }
  return Object.freeze({ installation, runtime: declaration.runtime, towerPort: declaration.towerPort as number, doorPort: declaration.doorPort as number });
}
