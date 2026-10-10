#!/usr/bin/env node
// Bring the installation's database up to date: what is applied, what is pending, and apply it after you confirm.
//
//   pnpm os:migrate                    what is applied and what is pending
//   pnpm os:migrate -- --apply         apply what is pending (asks for the database's name)
//   pnpm os:migrate -- --bootstrap --slug main --name "My sites"
//                                      the installation's one workspace, once
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
import { SECRETS_DIR_VARIABLE } from './postgres-secrets.mjs';
import { readSelector } from './stack-control.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SELECTOR = path.join(REPO_ROOT, '.local', 'stack.json');
/** The variable the owner's address rides in, from this command to psql only. */
const OWNER_URL_VARIABLE = 'NOTICEOS_OWNER_URL';

/** `KEY=value` lines of a Compose env file; quotes are stripped, comments skipped. */
export function readEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const raw = match[2];
    values[match[1]] = /^(['"]).*\1$/u.test(raw) ? raw.slice(1, -1) : raw.replace(/\s+#.*$/u, '');
  }
  return values;
}

/** The stack's Postgres secrets folder: the env file's NOTICEOS_POSTGRES_SECRETS,
 * relative to the Compose file that declares it, else `secrets` beside that file. */
export function stackSecretsDir(selector, io = { readFileSync, existsSync }) {
  const declaring = selector.files.find((file) => io.readFileSync(file, 'utf8').includes(SECRETS_DIR_VARIABLE)) ?? selector.files[0];
  const base = path.dirname(declaring);
  const named = readEnvFile(io.readFileSync(selector.envFile, 'utf8'))[SECRETS_DIR_VARIABLE];
  return named ? path.resolve(base, named) : path.join(base, 'secrets');
}

/** The owner's address and the database it names, from `<folder>/owner.url`. */
export function ownerTarget(folder, io = { readFileSync, existsSync }) {
  const file = path.join(folder, 'owner.url');
  if (!io.existsSync(file)) {
    throw new Error(`no owner.url in ${folder}: name the stack's Postgres secrets folder with --secrets <folder>`);
  }
  const url = io.readFileSync(file, 'utf8').trim();
  let database;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ''));
  } catch {
    throw new Error(`${file} does not hold a postgresql:// address`);
  }
  if (!database) throw new Error(`${file} names no database`);
  return { url, database };
}

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
    target = ownerTarget(folder, io);
  } catch (error) {
    err.write(`refused: ${error.message}\n`);
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
