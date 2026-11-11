// The public demo's own Ntasks, run as its ntasks service runs it: the pinned
// Ntasks build (scripts/demo-ntasks-build.mjs) in Miniflare, its D1 database
// provisioned by Ntasks's provision command, its store loaded from the
// scenario's seed through the seed credential. The demo's task pages and MCP
// tools read it as a visitor and every change from them is refused; the
// simulator files, claims, closes and comments through the demo credential;
// the history setup writes ends where the live boards stand at the cutoff.
// It needs a built Ntasks: NOTICEOS_NTASKS_ROOT names one (the CI demo-ntasks
// job builds it), and without one these tests are skipped.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { generateDemoScenario } from './demo-scenario.mjs';
import { applyDemoNtasksProvision, createDemoTaskGateway, createDemoTaskService, demoNtasks, demoNtasksProvisionRequest,
  demoNtasksWorker, DEMO_NTASKS_CREDENTIALS, openDemoTasks } from './demo-ntasks.mjs';
import { demoNtasksSeed } from './demo-ntasks-seed.mjs';
import { demoTaskHistory } from './demo-task-history.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';

const NTASKS = process.env.NOTICEOS_NTASKS_ROOT;
const skip = NTASKS ? false : 'needs a built Ntasks in NOTICEOS_NTASKS_ROOT (node scripts/demo-ntasks-build.mjs --out <folder>)';
// Setup seeds at its cutoff, the moment it runs, and Ntasks reads its boards'
// closes back from its own clock; so the scenario here is cut a second ago.
const scenario = generateDemoScenario({ seed: 'synthetic-work-v2', cutoff: new Date(Date.now() - 1000).toISOString(), release: '1'.repeat(40) });
const workspaceId = scenario.manifest.workspaceId;
const PUBLIC = 'https://demo.example.com';

describe('the demo task gateway', () => {
  test('refuses every change before asking Ntasks anything', async () => {
    let asked = 0;
    const gateway = createDemoTaskGateway({ ntasks: { call: async () => { asked++; return { status: 200, body: {} }; }, tool: async () => null } });
    for (const [method, at] of [['POST', '/api/tasks'], ['PATCH', '/api/tasks/lb-a1b2'], ['POST', '/api/tasks/lb-a1b2/close'], ['POST', '/api/gates/lb-g1/resolve']]) {
      const response = await gateway(new Request(PUBLIC + at, { method, body: '{}' }));
      assert.deepEqual([method, at, response.status, (await response.json()).error], [method, at, 403, 'demo_read_only']);
    }
    assert.equal(asked, 0);
  });
});

describe('the demo\'s own Ntasks', { skip }, () => {
  let miniflare, origin, folder, provision, seed, projects;
  const cli = (...args) => execFileSync(process.execPath, [path.join(NTASKS, 'tools/migrate/src/cli.ts'), ...args], { encoding: 'utf8' });

  before(async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-ntasks-'));
    fs.writeFileSync(path.join(folder, 'request.json'), JSON.stringify(demoNtasksProvisionRequest(scenario)));
    cli('provision', '--from', path.join(folder, 'request.json'), '--out', path.join(folder, 'provision.json'));
    provision = JSON.parse(fs.readFileSync(path.join(folder, 'provision.json'), 'utf8'));
    const wrangler = createRequire(createRequire(new URL('../workers/ingest/package.json', import.meta.url)).resolve('wrangler/package.json'));
    const { Miniflare, Log } = v4Miniflare(wrangler);
    miniflare = new Miniflare({ ...demoNtasksWorker({ bundleRoot: path.join(NTASKS, 'dist'), authSecret: 'test-only-demo-ntasks-secret-0123456789', workspaceId }),
      host: '127.0.0.1', port: 0, cf: false, resourcePersistencePath: path.join(folder, 'state'), log: new Log(0), handleStructuredLogs: () => undefined });
    origin = (await miniflare.ready).origin;
    await applyDemoNtasksProvision(await miniflare.getD1Database('DB'), provision);
    seed = demoNtasksSeed(scenario);
    fs.writeFileSync(path.join(folder, 'seed.json'), JSON.stringify(seed));
    fs.writeFileSync(path.join(folder, 'seed.token'), `${provision.tokens[DEMO_NTASKS_CREDENTIALS.seed]}\n`, { mode: 0o600 });
    cli('seed', '--from', path.join(folder, 'seed.json'), '--out', path.join(folder, 'backup.json'));
    assert.match(cli('load', '--api', origin, '--token-file', path.join(folder, 'seed.token'), '--from', path.join(folder, 'backup.json')), /0 differences\./u);
    projects = new Map(seed.projects.map(project => [project.prefix, project.id]));
  });
  after(async () => {
    await miniflare?.dispose();
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  });

  /** The demo's task routes and MCP endpoint, as its server sends visitors' requests to them. */
  const pages = () => openDemoTasks({ trustedOrigin: PUBLIC, demoWorkspaceId: workspaceId, ntasks: { origin } });
  const read = async (tasks, at) => { const response = await tasks.handle(new Request(PUBLIC + at)); return { status: response.status, body: await response.json() }; };
  const mcp = async (tasks, name, args) => {
    const response = await tasks.handle(new Request(PUBLIC + '/api/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { workspace: workspaceId, ...args } } }), headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', origin: PUBLIC } }));
    return (await response.json()).result;
  };

  test('the demo\'s task pages list the scenario\'s tasks, each closed one with its closer and model', async () => {
    const tasks = pages();
    const listed = await read(tasks, '/api/tasks/projects');
    assert.deepEqual(listed.body.projects.map(project => project.prefix).sort(), scenario.manifest.taskProjects.map(project => project.prefix).sort());
    for (const project of scenario.manifest.taskProjects) {
      const board = await read(tasks, `/api/tasks?project=${projects.get(project.prefix)}&status=open,in_progress,blocked,deferred`);
      const expected = scenario.tasks.filter(task => task.prefix === project.prefix && task.events.at(-1).status !== 'closed').map(task => task.id).sort();
      assert.deepEqual(board.body.tasks.map(task => task.id).sort(), expected, project.prefix);
    }
    const fact = scenario.tasks.find(task => task.events.at(-1).status === 'closed' && task.model && task.events.at(-1).assignee === 'claude');
    const detail = await read(tasks, `/api/tasks/${fact.id}?project=${projects.get(fact.prefix)}`);
    assert.equal(detail.status, 200);
    assert.deepEqual([detail.body.task.metadata.noticeos_closed_by, detail.body.task.metadata.noticeos_closed_model], ['claude', fact.model]);
    assert.equal(detail.body.comments.length, fact.comments.length);
    const stats = await read(tasks, '/api/tasks/agent-stats');
    assert.deepEqual([stats.status, stats.body.broken], [200, []]);
    const mcpRead = await mcp(tasks, 'get_task', { task: fact.id });
    assert.equal(mcpRead.structuredContent.task.id, fact.id);
  });

  test('a visitor\'s changes are refused, by the demo and by Ntasks itself, and change nothing', async () => {
    const tasks = pages();
    const fact = scenario.tasks.find(task => task.events.at(-1).status === 'open' && task.issueType === 'task');
    const projectId = projects.get(fact.prefix);
    const before = await read(tasks, `/api/tasks/${fact.id}?project=${projectId}`);
    const page = await tasks.handle(new Request(PUBLIC + `/api/tasks/${fact.id}/comments`, { method: 'POST', body: JSON.stringify({ projectId, text: 'hello' }) }));
    assert.deepEqual([page.status, (await page.json()).error], [403, 'demo_read_only']);
    for (const [name, args] of [['create_task', { project: projectId, title: 'A visitor task' }], ['comment_on_task', { task: fact.id, text: 'hello' }],
      ['claim_task', { task: fact.id }]]) {
      const refused = await mcp(tasks, name, args);
      assert.equal(refused.isError, true, name);
      assert.match(refused.content[0].text, /^refused: Read only in this synthetic demo\./u, name);
    }
    const asVisitor = await demoNtasks({ workspaceId, origin }).tool('create_task', { project: projectId, title: 'A visitor task' })
      .then(() => 'written', error => error.message);
    assert.match(asVisitor, /^refused: this call needs tasks:write/u);
    const direct = await demoNtasks({ workspaceId, origin }).call('POST', `/api/tasks/${fact.id}/comments`, { body: { projectId, text: 'hello' }, idempotencyKey: 'visitor-comment-1' });
    assert.deepEqual([direct.status, direct.body.error], [403, 'insufficient_scope']);
    assert.deepEqual((await read(tasks, `/api/tasks/${fact.id}?project=${projectId}`)).body.task, before.body.task);
  });

  test('the history setup writes ends where the live boards stand at the cutoff', async () => {
    const live = createDemoTaskService({ ntasks: demoNtasks({ workspaceId, origin, token: provision.tokens[DEMO_NTASKS_CREDENTIALS.activity] }),
      now: () => Date.parse(scenario.manifest.cutoff) });
    const sites = scenario.manifest.taskProjects.filter(project => !scenario.assets.find(asset => asset.id === project.asset).isOs)
      .map(project => ({ asset: project.asset, prefix: project.prefix, projectId: projects.get(project.prefix) }));
    const snapshot = await live.snapshot(sites, AbortSignal.timeout(30_000));
    const history = demoTaskHistory(seed, scenario);
    const last = history.at(-1);
    assert.equal(last.capturedAt, scenario.manifest.cutoff);
    assert.ok(history.every(day => day.projects.every(project => project.ok)));
    for (const entry of snapshot.projects) {
      const kept = last.projects.find(project => project.asset === entry.asset);
      assert.deepEqual({ counts: kept.counts, epics: kept.epics }, { counts: entry.counts, epics: entry.epics }, entry.asset);
    }
  });

  test('the simulator files, claims and closes as the named agent, and reaches only the sites\' projects', async () => {
    const tasks = createDemoTaskService({ ntasks: demoNtasks({ workspaceId, origin, token: provision.tokens[DEMO_NTASKS_CREDENTIALS.activity] }) });
    const signal = AbortSignal.timeout(30_000);
    const site = scenario.manifest.taskProjects.find(project => !scenario.assets.find(asset => asset.id === project.asset).isOs);
    const projectId = projects.get(site.prefix);
    const id = await tasks.create(projectId, { title: 'Review the week', description: 'Synthetic.', acceptance: 'Reviewed.',
      labels: ['synthetic-demo', 'synthetic:test-week'] }, 'test-week', signal);
    await tasks.claim(id, 'codex', 'GPT-5-Codex', signal);
    assert.deepEqual(await tasks.labelled(projectId, 'synthetic:test-week', signal),
      [{ id, type: 'task', status: 'in_progress', assignee: 'service:demo/codex', labels: ['synthetic-demo', 'synthetic:test-week'] }]);
    await tasks.close(id, 'Reviewed the week.', 'codex', 'GPT-5-Codex', signal);
    await tasks.comment(id, 'Verdict posted. Window w-1.', 'outcome-task-updates', signal);
    assert.deepEqual(await tasks.comments(projectId, id, signal), [{ author: 'service:demo/outcome-task-updates', text: 'Verdict posted. Window w-1.' }]);
    const closed = (await pages().handle(new Request(`${PUBLIC}/api/tasks/${id}?project=${projectId}`)));
    const task = (await closed.json()).task;
    assert.deepEqual([task.status, task.metadata.noticeos_closed_by, task.metadata.noticeos_closed_model], ['closed', 'service:demo/codex', 'GPT-5-Codex']);
    const own = scenario.manifest.taskProjects.find(project => scenario.assets.find(asset => asset.id === project.asset).isOs);
    await assert.rejects(tasks.create(projects.get(own.prefix), { title: 'Not here', description: '', acceptance: '', labels: [] }, 'test-own', signal),
      /names no project in this workspace/u);
  });
});
