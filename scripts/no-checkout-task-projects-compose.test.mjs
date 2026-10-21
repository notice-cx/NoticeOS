import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

// Opt-in pinned-client acceptance; all stores and files are disposable fixtures.
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { readTaskProjects } from './task-project-config.mjs';
import { taskChildEnvironment } from './task-client.mjs';
import { linkedProjects } from './standalone-mcp.mjs';
import { standaloneProjectId, standaloneTaskDirectory, createStandaloneTaskExecutor } from './standalone-tasks.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';
import { collectBeadsSnapshot } from './runner/task-snapshot.mjs';
import { runCommand } from './run-command.mjs';

test('pinned client creates, claims and closes through generated no-checkout configuration and snapshots the same connection', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR !== '1', timeout: 240000,
}, async t => {
  process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE = await fs.mkdtemp(
    path.join(process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE, 'no-checkout-'));
  await withOwnedTaskProjects(async facts => {
    const mapping = facts.mappings[0];
    const target = await facts.resolveTarget(mapping);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'no-checkout-real-'));
    try {
      const binding = { asset: 'fixture.example', prefix: 'tt', database: mapping.databaseKey };
      const env = { PATH: process.env.PATH, NOTICEOS_TASK_CLIENT_PROFILE: target.clientProfile,
        NOTICEOS_INSTALLATION_DIR: path.join(root, 'installation'), TMPDIR: process.env.TMPDIR,
        GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
      const resolved = await readTaskProjects({ repoRoot: root, env, token: 'fixture',
        readHost: async () => JSON.stringify({ repositories: [binding] }),
        fetchImpl: async () => Response.json({ ready: true, documents: [{ file: 'config/beads.json', version: 1, body: { spokes: [binding] } }] }),
      });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].repo, '');
      const cwd = resolved[0].cwd;
      assert.ok(cwd.startsWith(path.join(root, 'installation', 'task-projects') + path.sep));
      const metadata = JSON.parse(await fs.readFile(path.join(cwd, '.beads', 'metadata.json'), 'utf8'));
      assert.equal(metadata.project_id, undefined);
      assert.equal(metadata.dolt_database, mapping.databaseKey);
      await assert.rejects(fs.stat(path.join(cwd, '.git')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(root, '.beads')), { code: 'ENOENT' });
      const commands = [];
      const executeClient = async (argv, directory) => {
        commands.push({ argv: [...argv], directory });
        const reply = await runCommand(facts.pinnedBinary.path, argv, { cwd: directory,
          env: taskChildEnvironment(env), timeoutMs: 30000 });
        assert.equal(reply.code, 0, `pinned client failed: ${reply.stderr.slice(0, 1000)}`);
        return reply;
      };
      const projects = linkedProjects({ read: async () => resolved, root });
      const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol('real-no-checkout'),
        authority: async () => ({ principalId: 'fixture-agent', workspaceId: mapping.workspaceId, workspaceStatus: 'active' }) });
      const executor = createStandaloneTaskExecutor({ admission, projects, run: executeClient });
      const directory = standaloneTaskDirectory(projects, async () => [{ id: binding.asset, displayName: 'Fixture', isOs: false }]);
      const mcp = createHostedMcp({ profile: 'standalone', trustedOrigin: 'http://localhost', standaloneWorkspaceId: mapping.workspaceId,
        operations: createHostedTaskOperations({ admission, directory, executor, receipts: memoryReceipts(Date.now) }) });
      let next = 1;
      const tool = async (name, args) => {
        const response = await mcp(new Request('http://localhost' + MCP_PATH, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name,
            arguments: { workspace: mapping.workspaceId, ...args } } }) }));
        const result = (await response.json()).result;
        assert.equal(result.isError, undefined, JSON.stringify(result));
        return result.structuredContent;
      };
      const project = standaloneProjectId(mapping.databaseKey);
      assert.deepEqual((await tool('list_projects', {})).projects.map(row => [row.projectId, row.prefix]), [[project, 'tt']]);
      const created = await tool('create_task', { project, title: 'No checkout real-client fixture',
        acceptance: 'The pinned client reads, claims and closes this task', idempotency_key: 'no-checkout-real-create' });
      assert.match(created.id, /^tt-[a-z0-9]+$/u);
      const claimed = await tool('claim_task', { project, task: created.id, idempotency_key: 'no-checkout-real-claim' });
      assert.equal(claimed.task.status, 'in_progress');
      assert.equal(claimed.task.assignee, 'fixture-agent');
      const snapshot = await collectBeadsSnapshot({ projects: resolved, repoRoot: root,
        run: argv => executeClient(argv, cwd), nowMs: Date.now() });
      assert.equal(snapshot.projects[0].ok, true, snapshot.projects[0].error);
      assert.equal(snapshot.projects[0].counts.inProgress, 1);
      const closed = await tool('close_task', { project, task: created.id, reason: 'Pinned no-checkout acceptance verified',
        idempotency_key: 'no-checkout-real-close' });
      assert.equal(closed.task.status, 'closed');
      const replay = await tool('create_task', { project, title: 'No checkout real-client fixture',
        acceptance: 'The pinned client reads, claims and closes this task', idempotency_key: 'no-checkout-real-create' });
      assert.equal(replay.id, created.id);
      assert.ok(commands.length > 0 && commands.every(row => row.directory === cwd));
      await assert.rejects(fs.stat(path.join(cwd, '.git')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(root, '.beads')), { code: 'ENOENT' });
      const residual = (await fs.readdir(path.join(root, 'installation', 'task-projects'))).filter(name => name.startsWith('.prepare-'));
      assert.deepEqual(residual, []);
      t.diagnostic(`Pinned Beads ${facts.pinnedBinary.sha256}; Dolt ${facts.pinnedDoltBinary.sha256}; ${commands.length} actual task-client calls`);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
