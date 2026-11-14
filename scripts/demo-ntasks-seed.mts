// The demo scenario's tasks as an Ntasks seed: the projects and dated work
// that Ntasks's seed command turns into a store (tools/migrate in Ntasks,
// "Seed a store"). The seed holds exactly the scenario's facts and the alerts
// setup joins to them, so every generation of a demo with the same seed and
// cutoff seeds the same tasks. Setup writes it (scripts/hosted-demo-setup.mts).
import { createHash } from 'node:crypto';
import { HANDOFF_LABEL, TASK_METADATA } from '../packages/contract/src/task-metadata.mjs';
import type { generateDemoScenario } from './demo-scenario.mjs';
import { DEMO_BUILDER, DEMO_VERIFIER, type DemoTaskFact } from './demo-task-facts.mjs';

export const NTASKS_SEED_FORMAT = 'ntasks-seed-v1';
/** The operator who files every demo task, as the scenario names her. */
const OPERATOR = 'Mara';
const AGENTS: ReadonlySet<string> = new Set([DEMO_BUILDER, DEMO_VERIFIER]);

export interface NtasksSeedProject { id: string; key: string; name: string; prefix: string; createdAt: string }
export interface NtasksSeedChange {
  at: string; by: string; model?: string;
  status?: string; assignee?: string | null; deferUntil?: string | null;
  metadata?: Record<string, unknown>; close?: { reason: string };
}
export interface NtasksSeedTask {
  id: string; type: DemoTaskFact['issueType']; title: string; description: string; acceptance: string; priority: number;
  parent?: string; labels: string[]; links?: { type: 'blocks'; to: string }[]; metadata: Record<string, unknown>;
  awaitsPerson?: true; choices?: unknown;
  createdAt: string; createdBy: string; changes: NtasksSeedChange[];
  comments: { author: string; text: string; at: string }[];
}
export interface NtasksSeed { format: typeof NTASKS_SEED_FORMAT; projects: NtasksSeedProject[]; tasks: NtasksSeedTask[] }

interface SeedBackup {
  format: 'ntasks-backup-v1';
  tables: {
    tasks: { id: string; type: string; await_type: string | null; steps?: string | null }[];
    task_events: { task_id: string; kind: string; changes: string }[];
  };
}

/** The pinned Ntasks seed format has no steps field. Its backup format holds
 * the checklist in both the task row and the creation event. */
export function addDemoChecklistSteps(backup: SeedBackup, facts: readonly DemoTaskFact[]): void {
  for (const fact of facts) {
    if (!fact.steps) continue;
    const task = backup.format === 'ntasks-backup-v1' && backup.tables.tasks.find(row => row.id === fact.id);
    const created = backup.tables.task_events.find(event => event.task_id === fact.id && event.kind === 'created');
    if (!task || task.type !== 'gate' || task.await_type !== 'human' || task.steps != null || !created) {
      throw new Error('Demo checklist has no matching Ntasks seed request.');
    }
    const steps = fact.steps.map(({ text }) => ({ text, command: null, done: null, note: null, stuck: null }));
    task.steps = JSON.stringify(steps);
    created.changes = JSON.stringify({ ...JSON.parse(created.changes), steps });
  }
}

type Scenario = ReturnType<typeof generateDemoScenario>;
/** A task that answers one of the scenario's alerts: the alert's asset, rule
 * and key, which setup reads from the alerts the release raised. */
export interface DemoAlertJoin { readonly task: string; readonly asset: string; readonly rule: string; readonly key: string }

/** A project's id in Ntasks: a UUID fixed by the demo's workspace and the project's prefix. */
export function demoNtasksProjectId(workspaceId: string, prefix: string): string {
  const hex = createHash('sha256').update(`${workspaceId}\0ntasks-project\0${prefix}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One fact as a seed task: filed by the operator, then each dated move, with
 * the holder's model on the holder's own changes and the card once recorded.
 * A task that answers an alert carries the hand-off label and the alert's
 * identity, so its finding card shows it. */
function seedTask(task: DemoTaskFact, facts: readonly DemoTaskFact[], join: DemoAlertJoin | undefined): NtasksSeedTask {
  const [filed, ...moves] = task.events;
  if (!filed) throw new Error(`Demo task ${task.id} has no filing.`);
  const base = { synthetic: true, [TASK_METADATA.changeClass.name]: task.changeClass,
    ...(join ? { [TASK_METADATA.source.name]: HANDOFF_LABEL, [TASK_METADATA.asset.name]: join.asset, [TASK_METADATA.kind.name]: 'alert',
      [TASK_METADATA.rule.name]: join.rule, [TASK_METADATA.key.name]: join.key } : {}) };
  const timed: { at: string; order: number; change: NtasksSeedChange }[] = [];
  let status = 'open';
  let assignee: string | null = null;
  [filed, ...moves].forEach((event, order) => {
    const by = event.assignee ?? assignee ?? OPERATOR;
    const change: NtasksSeedChange = { at: event.at, by };
    if (task.model && AGENTS.has(by)) change.model = task.model;
    if (event.status !== status) change.status = event.status;
    if (event.assignee !== assignee) change.assignee = event.assignee;
    if (event.status === 'deferred' && status !== 'deferred') change.deferUntil = task.deferUntil ?? null;
    if (event.status !== 'deferred' && status === 'deferred') change.deferUntil = null;
    if (event.status === 'closed' && status !== 'closed') change.close = { reason: task.closeEvidence ?? 'Closed.' };
    status = event.status;
    assignee = event.assignee;
    if (Object.keys(change).some(key => !['at', 'by', 'model'].includes(key))) timed.push({ at: event.at, order, change });
  });
  if (task.card) {
    const { by, at, ...card } = task.card;
    timed.push({ at, order: timed.length, change: { at, by, metadata: { ...base, [TASK_METADATA.card.name]: { ...card, by, at } } } });
  }
  timed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order));
  const gates = facts.filter(gate => gate.blocks === task.id).map(gate => gate.id);
  const waitsOn = [...(task.dependsOn ? [task.dependsOn] : []), ...gates];
  return {
    id: task.id, type: task.issueType, title: task.title, description: task.description, acceptance: task.acceptance,
    priority: task.priority, ...(task.parent ? { parent: task.parent } : {}),
    labels: ['synthetic-demo', ...(task.human ? ['human'] : []), ...(join ? [HANDOFF_LABEL] : [])],
    ...(waitsOn.length ? { links: waitsOn.map(to => ({ type: 'blocks' as const, to })) } : {}),
    metadata: base, ...(task.issueType === 'gate' ? { awaitsPerson: true as const } : {}),
    ...(task.choices ? { choices: task.choices } : {}),
    createdAt: filed.at, createdBy: OPERATOR, changes: timed.map(entry => entry.change),
    comments: task.comments.map(({ author, text, at }) => ({ author, text, at })),
  };
}

/** The scenario's task projects and tasks as an Ntasks seed, with the tasks that answer `joins`' alerts marked so. */
export function demoNtasksSeed(scenario: Scenario, joins: readonly DemoAlertJoin[] = []): NtasksSeed {
  const { manifest, assets, tasks } = scenario;
  const projects = manifest.taskProjects.map(({ asset, prefix }) => {
    const site = assets.find(entry => entry.id === asset);
    if (!site) throw new Error(`Demo task project ${prefix} names no asset.`);
    return { id: demoNtasksProjectId(manifest.workspaceId, prefix), key: prefix, name: site.name, prefix, createdAt: site.createdAt };
  });
  if (joins.some(join => !tasks.some(task => task.id === join.task && task.asset === join.asset))) throw new Error('A demo alert names no task of its site.');
  return { format: NTASKS_SEED_FORMAT, projects, tasks: tasks.map(task => seedTask(task, tasks, joins.find(join => join.task === task.id))) };
}
