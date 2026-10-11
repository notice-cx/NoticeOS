#!/usr/bin/env node
// The installation's MCP server for agents on its own machine, over stdio:
// `pnpm os:mcp` (or the folder's `noticeos mcp`) runs it inside the app
// container, where the task client, the database and the Tower already are,
// so an agent's machine needs no task client of its own. The tools are the
// hosted endpoint's (hosted-mcp.mts) in the installation's one workspace:
// tasks through the shared task operations, read models from the Tower.
//
//   --actor <name>  Who the task projects record for this agent's changes (default: agent).
//
// stdout carries MCP messages only; anything else goes to stderr.
import path from 'node:path';
import { openStore } from '../packages/postgres/src/store.mjs';
import { taskReceipts } from '../packages/postgres/src/task-receipts.mjs';
import { DATABASE_URL, DEFAULT_TOWER_ORIGIN, readDevSecretBindings } from './dev-secrets.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { serveMcpStdio } from './mcp-stdio.mjs';
import { runCommand } from './run-command.mjs';
import { REPO_ROOT, SECRET_FILES } from './runner/config.mjs';
import { createStandaloneTaskExecutor, standaloneProjectId, standaloneTaskDirectory } from './standalone-tasks.mjs';
import { taskChildEnvironment } from './task-client.mjs';
import { readTaskProjects } from './task-project-config.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';

const ORIGIN = 'http://localhost';
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HELP = 'Usage: local-mcp.mjs [--actor <name>]';
/** How long one read of the linked projects serves the calls after it. */
const PROJECTS_TTL_MS = 5_000;

export function parseOptions(argv) {
  if (argv.length === 0) return { actor: 'agent' };
  if (argv.length === 2 && argv[0] === '--actor' && ACTOR.test(argv[1])) return { actor: argv[1] };
  throw new Error(`${HELP}\nAn actor is 1–128 of A–Z a–z 0–9 . _ : / - starting with a letter or digit.`);
}

/** The linked task projects, as the Tower's task lane resolves them. */
export function linkedProjects({ read = readTaskProjects, root = REPO_ROOT, now = Date.now } = {}) {
  let cached = null;
  return async () => {
    if (cached && now() - cached.at < PROJECTS_TTL_MS) return cached.projects;
    const projects = Object.freeze((await read()).filter(project => project.repo).map(project => Object.freeze({
      projectId: standaloneProjectId(project.asset), asset: project.asset, prefix: project.prefix, cwd: path.resolve(root, project.repo) })));
    cached = { at: now(), projects };
    return projects;
  };
}

/** One task client command in a project's folder, with the declared task client. */
export async function runTaskClient(argv, cwd, { env = process.env, run = runCommand } = {}) {
  const result = await run(env.BEADS_BD_BIN ?? 'bd', [...argv], { cwd, env: taskChildEnvironment(env), timeoutMs: 30_000 });
  return { code: result.code, stdout: result.stdout };
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, err = process.stderr,
  secretFiles = SECRET_FILES } = {}) {
  let options;
  try { options = parseOptions(argv); } catch (error) { err.write(`${error.message}\n`); return 2; }
  let store, workspaceId;
  try {
    const { bindings } = await readDevSecretBindings(secretFiles);
    store = openStore(bindings[DATABASE_URL], { maxConnections: 2 });
    workspaceId = await store.onlyWorkspace();
  } catch (error) {
    await store?.close();
    err.write(`NoticeOS MCP could not reach the installation's database: ${error.message}\n`);
    return 1;
  }
  try {
    // Whoever may run this process operates the installation; it is reached
    // over stdio only, never from the network.
    const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol('local-mcp'),
      authority: async () => ({ principalId: options.actor, workspaceId, workspaceStatus: 'active' }) });
    const projects = linkedProjects();
    const operations = createHostedTaskOperations({ admission, directory: standaloneTaskDirectory(projects),
      executor: createStandaloneTaskExecutor({ admission, projects, run: runTaskClient }), receipts: taskReceipts(store) });
    const mcp = createHostedMcp({ profile: 'standalone', trustedOrigin: ORIGIN, standaloneWorkspaceId: workspaceId, operations,
      readModels: async request => fetch(DEFAULT_TOWER_ORIGIN + MCP_PATH,
        { method: 'POST', headers: request.headers, body: await request.text(), signal: request.signal }) });
    err.write(`NoticeOS MCP: serving this installation's tasks and reports as ${options.actor}.\n`);
    await serveMcpStdio(mcp, { input, output, url: ORIGIN + MCP_PATH });
    return 0;
  } finally {
    await store.close();
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
