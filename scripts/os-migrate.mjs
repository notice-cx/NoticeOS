#!/usr/bin/env node
// Bring the installation's database up to date: what is applied, what is pending, and apply it after you confirm.
//
//   pnpm os:migrate    What is applied and pending; `-- --apply` applies it after you type the database's name.
//   pnpm os:migrate -- --bootstrap --slug main --name "My sites"
//                      The installation's one workspace, once.
//
// It reads the stack selector (.local/stack.json, or --config) and finds the
// owner's address where the stack's Postgres keeps it: the
// NOTICEOS_POSTGRES_SECRETS folder its env file names, resolved as Compose
// resolves it, or `secrets` beside the Compose file that declares it.
// --secrets <folder> names that folder instead. The address never reaches
// the command line, a log or the screen.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { USAGE, main as migrate } from './postgres-apply.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { readSelector } from './stack-control.mjs';
import { secretAddress, stackSecretsDir } from './stack-database.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SELECTOR = path.join(REPO_ROOT, '.local', 'stack.json');
/** The variable the owner's address rides in, from this command to psql only. */
const OWNER_URL_VARIABLE = 'NOTICEOS_OWNER_URL';

const ask = async (question) => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
};

export async function main(argv = process.argv.slice(2), {
  out = process.stdout,
  err = process.stderr,
  env = process.env,
  io = { readFileSync, existsSync },
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  question = ask,
  run = migrate,
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv.filter((arg) => arg !== '--'),
      options: {
        apply: { type: 'boolean' },
        bootstrap: { type: 'boolean' },
        confirm: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' },
        json: { type: 'boolean' },
        secrets: { type: 'string' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    err.write(`refused: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (values.apply && values.bootstrap) {
    err.write(`refused: --apply or --bootstrap, not both\n${USAGE}\n`);
    return 2;
  }
  let target;
  try {
    const folder = values.secrets !== undefined
      ? path.resolve(values.secrets)
      : stackSecretsDir(readSelector(values.config ?? DEFAULT_SELECTOR), io);
    target = secretAddress(folder, 'owner.url', io);
  } catch (error) {
    err.write(`refused: ${error.message}; name the folder with --secrets <folder>\n`);
    return 2;
  }
  const command = values.apply ? 'apply' : values.bootstrap ? 'bootstrap' : 'status';
  const base = [command, '--database', target.database, '--url-from', OWNER_URL_VARIABLE];
  const extra = [
    ...(values.json ? ['--json'] : []),
    ...(values.slug !== undefined ? ['--slug', values.slug] : []),
    ...(values.name !== undefined ? ['--name', values.name] : []),
  ];
  const childEnv = { ...env, [OWNER_URL_VARIABLE]: target.url };
  const options = { env: childEnv, targetFlags: '' };
  if (command === 'status' || values.confirm !== undefined || !interactive) {
    return run([...base, ...extra, ...(values.confirm !== undefined ? ['--confirm', values.confirm] : [])], out, err, options);
  }
  // At a terminal: show the plan, then ask for the database's name once.
  const status = run(['status', '--database', target.database, '--url-from', OWNER_URL_VARIABLE], out, err, options);
  if (status !== 0) return status;
  const typed = await question(`Type ${target.database} to ${command === 'apply' ? 'apply what is pending' : 'create the workspace'}, or press Enter to stop: `);
  if (typed === '') {
    out.write('Nothing was changed.\n');
    return 0;
  }
  return run([...base, ...extra, '--confirm', typed], out, err, { ...options, planShown: true });
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
