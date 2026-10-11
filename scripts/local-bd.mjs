#!/usr/bin/env node
// The installation's task client for a person at its machine: `pnpm os:bd --
// <arguments>` (or the folder's `noticeos bd …`) runs bd inside the app
// container, in a linked task project, with the installation's own task
// client, so this machine needs no bd of its own. Agents use the MCP server
// (local-mcp.mjs) instead.
//
//   --project <prefix or asset>  Which project, when the installation links more than one
//                                and no task id among the arguments names one by its prefix.
//
// Changes are recorded as operator; bd's own --actor names someone else.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { invokedDirectly } from './invoked-directly.mjs';
import { REPO_ROOT } from './runner/config.mjs';
import { taskChildEnvironment } from './task-client.mjs';
import { readTaskProjects } from './task-project-config.mjs';

const TASK_ID = /^([a-z]{2,8})-[a-z0-9]+(?:\.[0-9]+)*$/u;

/** The project `wanted` names; else the one whose prefix the task ids among `args` share; else the only
 * linked one. Throws a sentence naming the choices. */
export function chooseProject(projects, wanted, args = []) {
  const linked = projects.filter(project => project.repo);
  const names = linked.map(project => `${project.prefix} (${project.asset})`).join(', ') || 'none';
  if (wanted === undefined) {
    const prefixes = new Set(args.map(arg => TASK_ID.exec(arg)?.[1]).filter(Boolean));
    const named = linked.filter(project => prefixes.has(project.prefix));
    if (named.length === 1 && prefixes.size === 1) return named[0];
    if (linked.length === 1) return linked[0];
    throw new Error(linked.length ? `Name a project with --project: ${names}.` : 'This installation links no task project.');
  }
  const found = linked.find(project => project.prefix === wanted || project.asset === wanted);
  if (!found) throw new Error(`No linked task project is ${wanted}; the linked ones: ${names}.`);
  return found;
}

export async function main(argv = process.argv.slice(2), { env = process.env, err = process.stderr, read = readTaskProjects,
  root = REPO_ROOT, spawnChild = spawn } = {}) {
  // --project is this command's own, wherever it stands; bd has no option of that name.
  let wanted;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && i + 1 < argv.length) wanted = argv[++i];
    else if (argv[i].startsWith('--project=')) wanted = argv[i].slice('--project='.length);
    else args.push(argv[i]);
  }
  if (!args.length) { err.write('Name the task command, e.g. list or ready.\n'); return 2; }
  let project;
  try { project = chooseProject(await read(), wanted, args); } catch (error) { err.write(`${error.message}\n`); return 1; }
  const child = spawnChild(env.BEADS_BD_BIN ?? 'bd', args, { cwd: path.resolve(root, project.repo), stdio: 'inherit',
    env: { ...taskChildEnvironment(env), BEADS_ACTOR: 'operator' } });
  return new Promise(resolve => { child.once('error', () => resolve(127)); child.once('exit', code => resolve(code ?? 1)); });
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
