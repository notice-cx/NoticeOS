import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDemoScenario } from './demo-scenario.mjs';
import { demoNtasksProjectId, demoNtasksSeed, NTASKS_SEED_FORMAT } from './demo-ntasks-seed.mjs';

const input = { seed: 'synthetic-work-v2', cutoff: '2026-10-16T12:00:00.000Z', release: '1'.repeat(40) };
const scenario = generateDemoScenario(input);
const seed = demoNtasksSeed(scenario);
const byId = new Map(seed.tasks.map(task => [task.id, task]));

/** A task's state after every change, as Ntasks's seed command applies them. */
function finalState(task) {
  const state = { status: 'open', assignee: null, close: null, closedBy: null, closedModel: null, assigneeModel: null };
  for (const change of task.changes) {
    if (change.status !== undefined) state.status = change.status;
    if (change.assignee !== undefined) {
      state.assignee = change.assignee;
      state.assigneeModel = change.assignee !== null && change.assignee === change.by ? change.model ?? null : null;
    }
    if (change.close) Object.assign(state, { close: change.close.reason, closedBy: change.by, closedModel: change.model ?? null });
  }
  return state;
}

test('the seed holds every task project and every task of the scenario, each in its prefix’s project', () => {
  assert.equal(seed.format, NTASKS_SEED_FORMAT);
  assert.deepEqual(seed.projects.map(project => project.prefix).sort(), scenario.manifest.taskProjects.map(project => project.prefix).sort());
  for (const project of seed.projects) {
    assert.equal(project.id, demoNtasksProjectId(scenario.manifest.workspaceId, project.prefix));
    assert.equal(project.key, project.prefix);
  }
  assert.deepEqual([...byId.keys()].sort(), scenario.tasks.map(task => task.id).sort());
  for (const task of seed.tasks) assert.ok(seed.projects.some(project => task.id.startsWith(`${project.prefix}-`)), task.id);
});

test('each task ends where the scenario leaves it at the cutoff, credited to the agent and model that did the work', () => {
  for (const fact of scenario.tasks) {
    const task = byId.get(fact.id);
    const last = fact.events.at(-1);
    const state = finalState(task);
    assert.equal(state.status, last.status, fact.id);
    assert.equal(state.assignee, last.assignee, fact.id);
    if (last.status === 'closed') {
      assert.equal(state.closedBy, last.assignee ?? 'Mara', fact.id);
      if (fact.model && ['claude', 'codex'].includes(last.assignee)) assert.equal(state.closedModel, fact.model, fact.id);
      if (fact.closeEvidence) assert.equal(state.close, fact.closeEvidence, fact.id);
    }
    const claim = fact.events.find(event => event.status === 'in_progress');
    if (claim && fact.model && claim.assignee) {
      const change = task.changes.find(entry => entry.status === 'in_progress');
      assert.equal(change.by, claim.assignee, fact.id);
      assert.equal(change.model, fact.model, fact.id);
    }
  }
});

test('changes and comments are dated in order, none before the task was filed or after the cutoff', () => {
  for (const task of seed.tasks) {
    let at = task.createdAt;
    for (const change of task.changes) {
      assert.ok(change.at >= at && change.at <= input.cutoff, task.id);
      at = change.at;
    }
    assert.ok(task.comments.every((comment, index) => comment.at >= task.createdAt && (!index || comment.at >= task.comments[index - 1].at)), task.id);
  }
});

test('a gate waits on a person and the task it holds waits on the gate; a card arrives as metadata once recorded', () => {
  const gates = scenario.tasks.filter(task => task.issueType === 'gate');
  assert.ok(gates.length > 0);
  for (const gate of gates) {
    assert.equal(byId.get(gate.id).awaitsPerson, true);
    assert.ok(byId.get(gate.blocks).links.some(link => link.type === 'blocks' && link.to === gate.id), gate.id);
  }
  const carded = scenario.tasks.find(task => task.card);
  const change = byId.get(carded.id).changes.find(entry => entry.metadata);
  assert.equal(change.at, carded.card.at);
  assert.deepEqual(change.metadata.noticeos_card, carded.card);
  assert.equal(byId.get(carded.id).metadata.noticeos_card, undefined);
});

test('the same scenario always gives the same seed', () => {
  assert.deepEqual(demoNtasksSeed(generateDemoScenario(input)), seed);
});

test('a task that answers an alert carries the alert identity and the hand-off label; no other task changes', () => {
  const story = scenario.manifest.stories.problem;
  const joined = demoNtasksSeed(scenario, [{ task: story.ref, asset: story.asset, rule: 'poisson-drop', key: '37' }]);
  const task = joined.tasks.find(row => row.id === story.ref);
  assert.deepEqual({ source: task.metadata.noticeos_source, asset: task.metadata.noticeos_asset, kind: task.metadata.noticeos_kind,
    rule: task.metadata.noticeos_rule, key: task.metadata.noticeos_key }, { source: 'noticeos-handoff', asset: story.asset, kind: 'alert', rule: 'poisson-drop', key: '37' });
  assert.ok(task.labels.includes('noticeos-handoff'));
  assert.deepEqual(task.links, byId.get(story.ref).links);
  assert.deepEqual(joined.tasks.filter(row => row.id !== story.ref), seed.tasks.filter(row => row.id !== story.ref));
  assert.throws(() => demoNtasksSeed(scenario, [{ task: story.ref, asset: 'another.example', rule: 'poisson-drop', key: '37' }]), /names no task of its site/u);
});
