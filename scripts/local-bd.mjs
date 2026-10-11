#!/usr/bin/env node
// The installation's task client for a person at its machine: `pnpm os:bd --
// <arguments>` (or the folder's `noticeos bd …`) runs bd inside the app
// container, in a linked task project, with the installation's own task
// client, so this machine needs no bd of its own. Agents use the MCP server
// (local-mcp.mjs) instead.
//
//   --project <prefix or asset>  Which project, when the installation links more than one.
//
// Changes are recorded as operator; bd's own --actor names someone else.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { invokedDirectly } from './invoked-directly.mjs';
import { REPO_ROOT } from './runner/config.mjs';
import { taskChildEnvironment } from './task-client.mjs';
import { readTaskProjects } from './task-project-config.mjs';

/** The project `wanted` names, or the only linked one. Throws a sentence naming the choices. */
export function chooseProject(projects, wanted) {
  const linked = projects.filter(project => project.repo);
  const names = linked.map(project => `${project.prefix} (${project.asset})`).join(', ') || 'none';
  if (wanted === undefined) {
    if (linked.length === 1) return linked[0];
    throw new Error(linked.length ? `Name a project with --project: ${names}.` : 'This installation links no task project.');
  }
  const found = linked.find(project => project.prefix === wanted || project.asset === wanted);
  if (!found) throw new Error(`No linked task project is ${wanted}; the linked ones: ${names}.`);
  return found;
}

export async function main(argv = process.argv.slice(2), { env = process.env, err = process.stderr, read = readTaskProjects,
  root = REPO_ROOT, spawnChild = spawn } = {}) {
  let wanted, args = argv;
  if (args[0] === '--project') { wanted = args[1]; args = args.slice(2); }
  else if (args[0]?.startsWith('--project=')) { wanted = args[0].slice('--project='.length); args = args.slice(1); }
  if (!args.length) { err.write('Name the task command, e.g. list or ready.\n'); return 2; }
  let project;
  try { project = chooseProject(await read(), wanted); } catch (error) { err.write(`${error.message}\n`); return 1; }
  const child = spawnChild(env.BEADS_BD_BIN ?? 'bd', args, { cwd: path.resolve(root, project.repo), stdio: 'inherit',
    env: { ...taskChildEnvironment(env), BEADS_ACTOR: 'operator' } });
  return new Promise(resolve => { child.once('error', () => resolve(127)); child.once('exit', code => resolve(code ?? 1)); });
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
