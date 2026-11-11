// The task history of one proven new synthetic installation: the scenario's
// tasks, as the public demo seeds its own Ntasks with them, and the daily task
// snapshots their dated changes leave (demo-task-history.mts).
import * as fs from 'node:fs';
import path from 'node:path';
import { generateDemoScenario, demoScenarioHash } from './demo-scenario.mjs';
import { demoIntegrationAssets, demoSchedules } from './demo-display.mjs';
import { demoNtasksSeed } from './demo-ntasks-seed.mjs';
import { demoTaskHistory } from './demo-task-history.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
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
  // The source inventory reads its three documents from the store, so the two
  // the demo leaves at their defaults are saved as they are.
  const files = ['config/beads.json', 'config/integrations.json', 'config/constants.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'];
  const held = await helpers.getConfigDocuments(capability, files);
  if (held.some(document => document.source === 'store' || document.version !== null)) throw new Error('Demo task configuration refuses previously stored documents.');
  const taskProjects = JSON.parse(fs.readFileSync(path.join(plan.root, files[0]), 'utf8'));
  const integrations = JSON.parse(fs.readFileSync(path.join(plan.root, files[1]), 'utf8'));
  const constants = JSON.parse(fs.readFileSync(path.join(plan.root, files[2]), 'utf8'));
  const [dimensions, panel] = files.slice(3).map(file => JSON.parse(fs.readFileSync(path.join(plan.root, file), 'utf8')));
  if (!Array.isArray(taskProjects.spokes) || taskProjects.spokes.length || !integrations.assets || Object.keys(integrations.assets).length) throw new Error('The demo needs the generic empty task and asset rosters.');
  const roster = { ...integrations, assets: demoIntegrationAssets(scenario) };
  const seeded = await helpers.seedConfigDocuments(capability, { actor: 'synthetic-demo-seeder', documents: { [files[0]]: taskProjects, [files[1]]: roster, [files[2]]: { ...constants, schedules: demoSchedules() }, [files[3]]: dimensions, [files[4]]: panel } }, Date.parse(scenario.manifest.cutoff));
  if (!seeded.ok || seeded.skipped.length || seeded.seeded.length !== files.length || seeded.seeded.some(row => row.version !== 1)) throw new Error('The new demo configuration was not exclusively seeded.');
  const before = await helpers.getConfigDocuments(capability, files);
  if (before.find(row => row.file === files[0])?.version !== 1 || JSON.stringify(before.find(row => row.file === files[0])?.body.spokes) !== '[]') throw new Error('The new task map differs from its empty version-one expectation.');
  // Spokes are a register, not a wholesale-editable setting. Insert its rows
  // through the existing register grammar after proving [] at version one.
  const applied = await helpers.applyConfigOps(capability, { actor: 'synthetic-demo-seeder', slug: 'demo-task-projects',
    expectVersions: { [files[0]]: 1 }, ops: scenario.manifest.taskProjects.map(project => ({ kind: 'file-json-insert', file: files[0], pointer: '/spokes/-', value: project })) }, Date.parse(scenario.manifest.cutoff));
  const document = applied.documents?.find(row => row.file === files[0]);
  if (!applied.ok || applied.applied !== scenario.manifest.taskProjects.length || document?.version !== 2 || JSON.stringify(document.body.spokes) !== JSON.stringify(scenario.manifest.taskProjects)) throw new Error('The ordinary config apply did not acknowledge the exact demo projects.');
  fs.mkdirSync(plan.installation, { recursive: true, mode: 0o700 });
  write(path.join(plan.installation, 'task-host.json'), { version: 1, repositories: receipt.projects });
  write(path.join(plan.installation, 'beads.json'), document.body);
  write(path.join(plan.installation, 'integrations.json'), roster);
  return { seeded, applied };
}

/** Each project's id is the one the public demo's Ntasks gives it. */
export async function createDemoTasks({ plan, scenario, createdPostgres, capability, writeSnapshot, joins = [] }) {
  if (!createdPostgres?.created || !createdPostgres.schema || typeof writeSnapshot !== 'function' || !capability?.STORE)
    throw new Error('Demo tasks require the proven new store and released snapshot writer.');
  if (demoScenarioHash(generateDemoScenario(scenario.manifest)) !== demoScenarioHash(scenario)) throw new Error('Task facts differ from their declared scenario.');
  if (present(path.join(plan.home, 'demo-tasks.json'))) throw new Error('Demo task setup refuses existing or incomplete task custody.');
  const parent = present(plan.home);
  if (!parent?.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(plan.home) !== plan.home) throw new Error('Demo tasks need their canonical new installation folder.');
  const seed = demoNtasksSeed(scenario, joins);
  const history = demoTaskHistory(seed, scenario);
  for (const snapshot of history) {
    const written = await writeSnapshot(capability, snapshot, Date.parse(snapshot.capturedAt));
    if (!written.ok) throw new Error('The released demo snapshot writer refused a task snapshot.');
  }
  const projects = scenario.manifest.taskProjects.map(project => ({ ...project, projectId: seed.projects.find(row => row.prefix === project.prefix).id }));
  const receipt = { version: 1, synthetic: true, scenarioHash: demoScenarioHash(scenario), workspaceId: scenario.manifest.workspaceId,
    release: scenario.manifest.release, projects, tasks: scenario.tasks.length, snapshots: history.length };
  writeDemoTaskReceipt(plan.home, receipt);
  return receipt;
}
