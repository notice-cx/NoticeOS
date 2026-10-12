import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDemoScenario, shiftDemoDay } from './demo-scenario.mjs';
import { demoTaskIssuesAt } from './demo-task-facts.mjs';

const input = { seed: 'synthetic-work-v2', cutoff: '2026-10-16T12:00:00.000Z', release: '1'.repeat(40) };
test('one scenario names six real task projects and all cross-store story identities', () => {
  const scenario = generateDemoScenario(input);
  assert.equal(scenario.manifest.scenarioVersion, 6);
  assert.equal(scenario.manifest.taskProjects.length, 6);
  assert.equal(scenario.tasks.filter(task => task.issueType === 'task').length, 77);
  assert.equal(scenario.tasks.filter(task => task.issueType === 'epic').length, 6);
  assert.equal(scenario.tasks.filter(task => task.issueType === 'gate').length, 3);
  assert.equal(new Set(scenario.tasks.map(task => task.id)).size, scenario.tasks.length);
  for (const project of scenario.manifest.taskProjects) {
    assert.ok(scenario.assets.some(asset => asset.id === project.asset && asset.prefix === project.prefix));
    assert.equal(project.database, `demo_${project.prefix}`);
    assert.ok(scenario.tasks.filter(task => task.asset === project.asset && task.issueType === 'task').length >= 8);
  }
  for (const task of scenario.tasks) {
    assert.match(task.id, /^[a-z]{2,8}-[a-zA-Z0-9]+(?:\.[0-9]+)*$/u);
    for (const target of [task.parent, task.dependsOn, task.blocks].filter(Boolean)) assert.ok(scenario.tasks.some(other => other.id === target && other.asset === task.asset));
    assert.ok(task.events.every((event, index) => event.at <= input.cutoff && (!index || event.at >= task.events[index - 1].at)));
    assert.ok(task.events.every(event => event.at >= scenario.assets.find(asset => asset.id === task.asset).createdAt));
  }
  const { stories: { repair, problem }, ship, slide } = scenario.manifest;
  assert.equal(scenario.tasks.find(task => task.id === repair.ref).title, 'Restore brief navigation');
  assert.equal(scenario.tasks.find(task => task.id === repair.readbackTaskId).title, 'Read the repair follow-up');
  assert.equal(scenario.tasks.find(task => task.id === problem.ref).title, 'Restore source saving');
  assert.equal(scenario.tasks.find(task => task.id === ship.ref).title, 'Speed up the recipe pages');
  assert.equal(scenario.tasks.find(task => task.id === slide.ref).title, 'Ship the trail page redesign');
  assert.ok(scenario.tasks.find(task => task.id === repair.readbackTaskId).events[0].at < repair.annotationAt);
});

test('every site board is moving on the reference day: done this week, in progress, blocked and asks aged hours to weeks', () => {
  const scenario = generateDemoScenario(input);
  const issues = demoTaskIssuesAt(scenario.tasks, input.cutoff);
  const weekAgo = new Date(Date.parse(input.cutoff) - 7 * 86_400_000).toISOString();
  for (const asset of scenario.assets.filter(asset => !asset.isOs)) {
    const mine = issues.filter(issue => issue.id.startsWith(`${asset.prefix}-`) && issue.issue_type === 'task');
    assert.ok(mine.filter(issue => issue.status === 'closed' && issue.closed_at >= weekAgo).length >= 3, asset.prefix);
    assert.ok(mine.some(issue => issue.status === 'in_progress'), asset.prefix);
    assert.ok(mine.some(issue => issue.status === 'open' && !issue.labels.includes('human')), asset.prefix);
  }
  // Something closed within the last day on every busy site, for the timeline.
  const dayAgo = new Date(Date.parse(input.cutoff) - 86_400_000).toISOString();
  assert.ok(['lb', 'pw', 'wp', 'tn', 'fr'].every(prefix => issues.some(issue => issue.id.startsWith(`${prefix}-`) && issue.closed_at >= dayAgo)));
  // What waits on the operator: human gates and open asks, from hours to weeks old.
  const waiting = issues.filter(issue => issue.status === 'open' && (issue.issue_type === 'gate' || issue.labels.includes('human')));
  const ages = waiting.map(issue => (Date.parse(input.cutoff) - Date.parse(issue.created_at)) / 3_600_000).sort((a, b) => a - b);
  assert.ok(waiting.length >= 5 && ages[0] <= 6 && ages.at(-1) >= 14 * 24);
  assert.ok(waiting.every(issue => issue.issue_type === 'gate' || !issue.dependencies.some(edge => edge.type === 'blocks')));
});

test('bd import rows retain dated comments, owners, acceptance, closure and only true dependency edges', () => {
  const scenario = generateDemoScenario(input);
  const issues = demoTaskIssuesAt(scenario.tasks, input.cutoff);
  assert.equal(issues.length, scenario.tasks.length);
  const gates = issues.filter(row => row.issue_type === 'gate');
  for (const gate of gates) {
    assert.equal(gate.await_type, 'human');
    assert.equal(gate.ephemeral, true);
    const consumers = issues.filter(issue => issue.dependencies.some(edge => edge.depends_on_id === gate.id));
    assert.equal(consumers.length, 1);
    assert.equal(consumers[0].id, scenario.tasks.find(task => task.id === gate.id).blocks);
  }
  const repair = issues.find(issue => issue.id === scenario.manifest.stories.repair.ref);
  assert.equal(repair.status, 'closed');
  assert.ok(repair.created_at < repair.started_at && repair.started_at < repair.closed_at);
  assert.ok(repair.closed_at > scenario.manifest.stories.repair.annotationAt);
  assert.match(repair.close_reason, /repair annotation/u);
  assert.equal(repair.comments.at(-1).author, 'Verifier');
  for (const issue of issues) {
    assert.ok(issue.comments.every(comment => comment.created_at <= input.cutoff));
    assert.ok(issue.created_at <= issue.updated_at && issue.updated_at <= input.cutoff);
    assert.ok(issue.assignee && issue.acceptance_criteria && issue.description);
  }
  const blocked = new Set(issues.flatMap(issue => issue.dependencies.filter(edge => edge.type === 'blocks').map(() => issue.id)));
  assert.ok(issues.some(issue => issue.status === 'open' && issue.issue_type === 'task' && !blocked.has(issue.id)));
  assert.ok(issues.some(issue => issue.status === 'deferred'));
  assert.ok(issues.some(issue => issue.status === 'in_progress'));
});

test('ordinary task briefs and closure evidence are specific, with only resolvable demo links', () => {
  const scenario = generateDemoScenario(input);
  const ordinary = scenario.tasks.filter(task => task.issueType === 'task');
  for (const field of ['description', 'acceptance']) assert.equal(new Set(ordinary.map(task => task[field])).size, ordinary.length);
  assert.equal(new Set(ordinary.map(task => task.comments[0].text)).size, ordinary.length);
  const closed = ordinary.filter(task => task.events.at(-1).status === 'closed');
  assert.equal(new Set(closed.map(task => task.closeEvidence)).size, closed.length);
  for (const task of ordinary) {
    assert.equal(task.description.includes('Synthetic acceptance'), false);
    for (const text of [task.title, task.description, task.acceptance, task.closeEvidence, ...task.comments.map(comment => comment.text)].filter(Boolean)) {
      assert.ok(text.trim().split(/\s+/u).length <= 12, `Task ${task.id} exceeds the visible-copy budget: ${text}`);
      assert.doesNotMatch(text, /report coverage/iu);
    }
    for (const text of [task.description, ...task.comments.map(comment => comment.text)]) {
      for (const [, id] of text.matchAll(/\/tasks\/([a-z]{2,8}-[a-f0-9]{6})/gu)) assert.ok(scenario.tasks.some(target => target.id === id));
      for (const [, asset] of text.matchAll(/\/assets\/([a-z0-9.-]+)/gu)) assert.ok(scenario.assets.some(target => target.id === asset));
    }
  }
});

test('the daily-report verification closes after collection resumes without inventing the missing report', () => {
  const scenario = generateDemoScenario(input);
  const missing = scenario.daily.find(day => day.reportMissing);
  const resumedReport = scenario.daily.find(day => day.asset === missing.asset && day.date === shiftDemoDay(missing.date, 1));
  assert.equal(resumedReport.reportMissing, false);
  const verification = scenario.tasks.find(task => task.title === 'Verify the recovered daily report');
  // A daily report is collected the following morning. Verification follows
  // that actual scenario event; the earlier absent report remains absent.
  const collectedAt = `${shiftDemoDay(resumedReport.date, 1)}T01:10:08.000Z`;
  assert.ok(verification.events.find(event => event.status === 'closed').at > collectedAt);
  assert.equal(scenario.daily.filter(day => day.reportMissing).length, 1);
});

test('dated projections never backfill future tasks or comments into an earlier state', () => {
  const scenario = generateDemoScenario(input);
  const at = '2026-08-01T23:59:59.000Z';
  const issues = demoTaskIssuesAt(scenario.tasks, at);
  assert.ok(issues.length < scenario.tasks.length);
  assert.ok(issues.every(issue => issue.created_at <= at && issue.updated_at <= at && issue.comments.every(comment => comment.created_at <= at)));
  assert.ok(!issues.some(issue => issue.id === scenario.manifest.stories.problem.ref));
  assert.ok(!issues.some(issue => issue.id === scenario.manifest.stories.repair.readbackTaskId && issue.status === 'closed'));
  assert.throws(() => demoTaskIssuesAt(scenario.tasks, 'today'));
});
