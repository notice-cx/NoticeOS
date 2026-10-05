// Dedicated real task projects for one proven new synthetic installation.
// Every task write goes through the pinned bd CLI, never task-table SQL.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { prepareFreshDolt, doltEnvironment } from './dolt-host.mjs';
import { BEADS_VERSION, checkBeadsCli, initDoltProject } from './dolt-project.mjs';
import { runCommand } from './run-command.mjs';
import { generateDemoScenario, demoScenarioHash, shiftDemoDay } from './demo-scenario.mjs';
import { demoTaskIssuesAt } from './demo-task-facts.mjs';
import { beadsClosedSince, beadsPollArgs, summarizeBeadsProject } from './runner/task-snapshot.mjs';
import { HANDOFF_LABEL, TASK_METADATA } from '../packages/contract/src/task-metadata.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, json(value), { flag: 'wx', mode: 0o600 });
const present = file => fs.lstatSync(file, { throwIfNoEntry: false });

/** Durable seed provenance consumed by the unchanged workflow-history writer. */
export function writeDemoTaskReceipt(home, receipt) {
  write(path.join(home, 'demo-tasks.json'), receipt);
}

/** Keep the ordinary configuration validator, version guard and audit writer.
 * This is available only after the new demo's actual task projects exist. */
export async function configureDemoTasks({ plan, scenario, receipt, capability, helpers }) {
  if (plan.installation !== path.join(plan.home, 'installation')) throw new Error('Demo task configuration needs its own installation folder.');
  const directory = present(plan.installation);
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new Error('Demo task configuration refuses an unsafe folder.');
  if (['task-host.json', 'beads.json', 'integrations.json'].some(file => present(path.join(plan.installation, file)))) throw new Error('Demo task configuration refuses existing exports.');
  const files = ['config/beads.json', 'config/integrations.json', 'config/constants.json'];
  const held = await helpers.getConfigDocuments(capability, files);
  if (held.some(document => document.source === 'store' || document.version !== null)) throw new Error('Demo task configuration refuses previously stored documents.');
  const beads = JSON.parse(fs.readFileSync(path.join(plan.root, files[0]), 'utf8'));
  const integrations = JSON.parse(fs.readFileSync(path.join(plan.root, files[1]), 'utf8'));
  const constants = JSON.parse(fs.readFileSync(path.join(plan.root, files[2]), 'utf8'));
  if (!Array.isArray(beads.spokes) || beads.spokes.length || !integrations.assets || Object.keys(integrations.assets).length) throw new Error('The demo needs the generic empty task and asset rosters.');
  const roster = { ...integrations, assets: Object.fromEntries(scenario.assets.map(asset => [asset.id, {}])) };
  const seeded = await helpers.seedConfigDocuments(capability, { actor: 'synthetic-demo-seeder', documents: { [files[0]]: beads, [files[1]]: roster, [files[2]]: constants } }, Date.parse(scenario.manifest.cutoff));
  if (!seeded.ok || seeded.skipped.length || seeded.seeded.length !== files.length || seeded.seeded.some(row => row.version !== 1)) throw new Error('The new demo configuration was not exclusively seeded.');
  const before = await helpers.getConfigDocuments(capability, files);
  if (before.find(row => row.file === files[0])?.version !== 1 || JSON.stringify(before.find(row => row.file === files[0])?.body.spokes) !== '[]') throw new Error('The new task map differs from its empty version-one expectation.');
  // Spokes are a register, not a wholesale-editable setting. Insert its rows
  // through the existing register grammar after proving [] at version one.
  const applied = await helpers.applyConfigOps(capability, { actor: 'synthetic-demo-seeder', slug: 'demo-task-projects',
    expectVersions: { [files[0]]: 1 }, ops: scenario.manifest.taskProjects.map(project => ({ kind: 'file-json-insert', file: files[0], pointer: '/spokes/-', value: project })) }, Date.parse(scenario.manifest.cutoff));
  const document = applied.documents?.find(row => row.file === files[0]);
  if (!applied.ok || applied.applied !== 4 || document?.version !== 2 || JSON.stringify(document.body.spokes) !== JSON.stringify(scenario.manifest.taskProjects)) throw new Error('The ordinary config apply did not acknowledge the exact demo projects.');
  fs.mkdirSync(plan.installation, { recursive: true, mode: 0o700 });
  write(path.join(plan.installation, 'task-host.json'), { version: 1, repositories: receipt.projects });
  write(path.join(plan.installation, 'beads.json'), document.body);
  write(path.join(plan.installation, 'integrations.json'), roster);
  return { seeded, applied };
}

/** Timestamp filtering only; blocker/epic/deferred/waiting rules remain bd's
 * native answers and the canonical summarizer's interpretation. */
export function demoHistoricalProject(project, reads, instant) {
  const since = beadsClosedSince(Date.parse(instant));
  const closed = JSON.parse(reads.closed.stdout).filter(row => row.closed_at?.slice(0, 10) >= since);
  return summarizeBeadsProject(project, { ...reads, closed: { ...reads.closed, stdout: JSON.stringify(closed) } });
}

export function demoHandoffIssues(rows, joins) {
  return rows.map(row => {
    const join = joins.find(item => item.task === row.id);
    if (!join) return row;
    return { ...row, labels: [...row.labels, HANDOFF_LABEL], metadata: {
      ...row.metadata, [TASK_METADATA.source.name]: HANDOFF_LABEL,
      [TASK_METADATA.asset.name]: join.asset, [TASK_METADATA.kind.name]: 'alert',
      [TASK_METADATA.rule.name]: join.rule, [TASK_METADATA.key.name]: join.key,
    } };
  });
}

/** Shared dated task-history seed; platform composition owns fresh physical
 * projects and supplies only the ordinary pinned bd command transport. */
export async function seedDemoTaskHistory({ scenario, projects, tasksDir, capability, writeSnapshot, joins = /** @type {Array<{task: string, asset: string, key: string, rule: string}>} */ ([]) }, execute) {
  /** @type {Array<{task: string, asset: string, key: string, rule: string}>} */
  const handoffs = joins;
  const records = [];
  const reads = new Map();
  const imported = new Map();
  const bd = async (project, args) => {
    const result = await execute(project, args);
    if (result.code !== 0 || result.error || result.timedOut) throw new Error('A demo task command did not finish; preserve its custody.');
    const value = JSON.parse(result.stdout);
    if (value?.skipped_dependencies?.length || value?.errors?.length) throw new Error('A demo task import lost dependencies or rows.');
    records.push({ project: project.asset, args, outputSha256: hash(value) });
    return result;
  };
  const first = scenario.assets.map(asset => asset.createdAt.slice(0, 10)).sort()[0];
  const last = scenario.manifest.referenceDate;
  let snapshots = 0;
  for (let day = first; day <= last; day = shiftDemoDay(day, 1)) {
    const instant = day === last ? scenario.manifest.cutoff : `${day}T23:59:59.000Z`;
    const current = [];
    for (const project of projects) {
      const rows = demoHandoffIssues(demoTaskIssuesAt(scenario.tasks.filter(task => task.asset === project.asset), instant), handoffs);
      if (instant < scenario.assets.find(asset => asset.id === project.asset).createdAt) continue;
      const identity = hash(rows);
      if (imported.get(project.asset) !== identity) {
        // Human gates are wisps in bd. Importing them in the ordinary issue
        // batch skips cross-bucket edges; gates must exist before their users.
        for (const [bucket, selected] of [['gates', rows.filter(row => row.issue_type === 'gate')], ['issues', rows.filter(row => row.issue_type !== 'gate')]]) {
          if (!selected.length) continue;
          const file = path.join(tasksDir, `${project.prefix}-${day}-${bucket}.jsonl`);
          fs.writeFileSync(file, selected.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
          await bd(project, ['import', file]);
        }
        // The pinned importer omits defer_until. Use its ordinary writer so
        // the native reader retains the dated decision, not just its status.
        for (const row of rows.filter(row => row.status === 'deferred' && row.defer_until)) {
          await bd(project, ['update', row.id, '--defer', row.defer_until]);
        }
        const answers = {};
        for (const [key, args] of Object.entries(beadsPollArgs(project.repo, beadsClosedSince(Date.parse(instant))))) {
          // Retain all native closed rows at this actual imported checkpoint;
          // only the ordinary reader's seven-day timestamp window changes
          // between unchanged days. No synthetic ready answer is invented.
          const selected = [...args.slice(2)];
          if (key === 'closed') selected.splice(selected.indexOf('--closed-after'), 2);
          answers[key] = await bd(project, selected);
        }
        reads.set(project.asset, answers);
        imported.set(project.asset, identity);
      }
      const summary = demoHistoricalProject(project, reads.get(project.asset), instant);
      if (!summary.ok || summary.counts.deferred === undefined || summary.counts.waiting === undefined || !summary.epics) throw new Error('A demo checkpoint could not prove its full task semantics.');
      current.push(summary);
    }
    const snapshot = { capturedAt: instant, projects: current };
    const written = await writeSnapshot(capability, snapshot, Date.parse(instant));
    if (!written.ok) throw new Error('The released demo snapshot writer refused its actual task reads.');
    snapshots++;
  }
  return { snapshots, commands: records };
}

export async function createDemoTasks({ plan, scenario, createdPostgres, capability, writeSnapshot, joins = [], env = {}, binary },
  { prepare = prepareFreshDolt, init = initDoltProject, check = checkBeadsCli, run = runCommand } = {}) {
  if (!createdPostgres?.created || !createdPostgres.schema || typeof writeSnapshot !== 'function' || !capability?.STORE)
    throw new Error('Demo tasks require the proven new store and released snapshot writer.');
  if (demoScenarioHash(generateDemoScenario(scenario.manifest)) !== demoScenarioHash(scenario)) throw new Error('Task facts differ from their declared scenario.');
  const tasksDir = path.join(plan.home, 'tasks');
  const receiptFile = path.join(plan.home, 'demo-tasks.json');
  if ([tasksDir, path.join(plan.home, 'dolt'), receiptFile].some(present)) throw new Error('Demo task setup refuses existing or incomplete task custody.');
  const parent = present(plan.home);
  if (!parent?.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(plan.home) !== plan.home) throw new Error('Demo tasks need their canonical new installation folder.');
  // Checking the executable happens outside any spoke/config before creation.
  const cli = await check({ env, run, binary });
  if (!cli.ok) throw new Error(cli.line);
  const binaryHash = () => createHash('sha256').update(fs.readFileSync(cli.binary)).digest('hex');
  const client = { version: BEADS_VERSION, sha256: binaryHash() };
  const safeRun = (command, args, options) => run(command, command === cli.binary && !args.includes('--sandbox') ? ['--sandbox', ...args] : args, options);
  const hosted = await prepare(plan, { fresh: true, env, run: safeRun });
  if (!hosted.ok || !hosted.created) throw new Error('Demo tasks did not prove a new task server; preserve its files.');
  const ownEnv = { ...doltEnvironment(hosted.profile, env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  fs.mkdirSync(tasksDir, { mode: 0o700 });
  const projects = [];
  for (const project of scenario.manifest.taskProjects) {
    const repo = path.join(tasksDir, project.prefix);
    fs.mkdirSync(repo, { mode: 0o700 });
    const initializedGit = await safeRun('git', ['init', '--quiet', repo], { cwd: plan.home, env: ownEnv });
    if (initializedGit.code !== 0 || initializedGit.error || initializedGit.timedOut) throw new Error('The own demo task checkout could not be created.');
    const initialized = await init({ home: plan.home, repo, prefix: project.prefix, database: project.database }, { env: ownEnv, run: safeRun, binary: cli.binary });
    if (!initialized.ok) throw new Error(initialized.line);
    projects.push({ ...project, repo });
  }
  const { snapshots, commands: records } = await seedDemoTaskHistory({ scenario, projects, tasksDir, capability, writeSnapshot, joins },
    (project, args) => safeRun(cli.binary, ['--sandbox', '-C', project.repo, ...args, '--json', '--actor', 'synthetic-demo-seeder'],
      { cwd: plan.home, env: ownEnv, timeoutMs: 90_000 }));
  if (binaryHash() !== client.sha256) throw new Error('The verified demo task client changed during generation; preserve its custody.');
  const receipt = { version: 1, synthetic: true, client, scenarioHash: demoScenarioHash(scenario), workspaceId: scenario.manifest.workspaceId,
    release: scenario.manifest.release, project: hosted.profile.project, projects, tasks: scenario.tasks.length,
    snapshots, commands: records, clock: 'bd answers use actual generation time. Historical states come from dated imports; no timer gates or leases are seeded. Explicit deferrals and their dates use the ordinary CLI writer; these native answers are not as-of reads.' };
  writeDemoTaskReceipt(plan.home, receipt);
  return receipt;
}
