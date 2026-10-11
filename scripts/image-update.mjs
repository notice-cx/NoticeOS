#!/usr/bin/env node
// Move an installation that runs from its image to main's newest published
// version, or back to the version before, after you confirm the plan.
//
//   noticeos update      to the image this runs from; the launcher runs it from main's newest
//   noticeos rollback    back to the version before the last update
//
// A version is an image and the stack definition copied out of it, and the
// two move together: the folder's stack/ becomes the new version's copy
// (stack.previous/ keeps the one before) and installation.env's
// NOTICEOS_APP_IMAGE names the new image. Every service whose declaration
// changed is then recreated as pnpm os:apply recreates it, databases first.
// If one does not become healthy, the definition, the image line and the
// services all return to the version before. A database image the new
// definition names is fetched before anything stops. No migration is ever
// applied: when the new version carries one the database lacks, it stops and
// names `migrate`. From a checkout, pnpm os:update and os:rollback move the app.

import * as fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { imageInstallation } from './image-installation.mjs';
import { copyStack, LAUNCHER, STACK_DIR } from './installation-layout.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { runCommand } from './run-command.mjs';
import { holdingStackLock, planChanges, portTaken, recordApplied, recreate } from './stack-apply.mjs';
import { readSelector } from './stack-control.mjs';
import { composePrefix, stackDatabaseCurrent } from './stack-database.mjs';
import { stackAtomic, stackImageMetadata, stackSnapshot } from './stack-deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = 'noticeos-image-previous/1';
const ROLES = path.join('db', 'postgres', 'roles.sql');
const IMAGE_LINE = /^NOTICEOS_APP_IMAGE="[^"\n]*"$/mu;

class UpdateRefused extends Error {}
const refuse = (line) => { throw new UpdateRefused(line); };
const ownEnv = (env) => Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
const short = (revision) => revision ? revision.slice(0, 12) : 'an unlabelled image';

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: { rollback: { type: 'boolean' }, confirm: { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (!values.help && (values.config === undefined || !path.isAbsolute(values.config))) refuse('--config names the installation\'s absolute stack.json.');
  return { help: values.help === true, rollback: values.rollback === true, confirm: values.confirm ?? null, selectorFile: values.config };
}

/** installation.env's text with the app image `image`. */
export function withImage(text, image) {
  if (!IMAGE_LINE.test(text)) refuse('installation.env names no NOTICEOS_APP_IMAGE.');
  return text.replace(IMAGE_LINE, `NOTICEOS_APP_IMAGE="${image}"`);
}

/**
 * The services whose declaration differs between `now` and `then` (each
 * `docker compose config` output), reading paths under `from` as paths under
 * `to`: a version's definition is compared where it will be, not where it is
 * staged. Throws when the two declare different services.
 */
export function changedServices(now, then, { from, to }) {
  const names = Object.keys(now.services ?? {}).sort();
  const theirs = Object.keys(then.services ?? {}).sort();
  if (names.join() !== theirs.join()) refuse(`the other version runs ${theirs.join(', ')} where this one runs ${names.join(', ')}; moving between them is not something update does. Nothing was changed.`);
  const moved = (value) => JSON.stringify(value).replaceAll(`${from}/`, `${to}/`);
  return names.filter((name) => moved(then.services[name]) !== JSON.stringify(now.services[name]));
}

const ask = async (question) => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(question)).trim(); } finally { prompt.close(); }
};

export async function moveVersion(options, { run = runCommand, env = process.env, out = process.stdout, root = ROOT,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), question = ask, database = stackDatabaseCurrent } = {}) {
  const say = (line) => out.write(`${line}\n`);
  const verb = options.rollback ? 'rollback' : 'update';
  const installation = imageInstallation(env);
  if (!installation) refuse('this moves an installation that runs from its image; from a checkout, pnpm os:update and pnpm os:rollback move the app.');
  const docker = async (args, what, { timeoutMs = 60_000, inherit = false } = {}) => {
    let result;
    try { result = await run('docker', args, { env: ownEnv(env), timeoutMs, inherit }); } catch { result = { code: 1 }; }
    if (result.code !== 0) refuse(`${what} failed${inherit ? '; Docker\'s output above says why' : ''}.`);
    return result.stdout ?? '';
  };
  const selector = readSelector(options.selectorFile);
  const dir = path.dirname(selector.envFile);
  const stack = path.join(dir, STACK_DIR);
  const previous = `${stack}.previous`;
  const next = `${stack}.next`;
  const spare = `${stack}.spare`;
  const records = path.join(path.dirname(options.selectorFile), 'stack-apply');
  const recordFile = path.join(records, 'previous-version.json');
  if (!selector.files.every((file) => file.startsWith(`${stack}/`))) refuse(`${options.selectorFile} does not read the stack definition from ${stack}; this installation runs from a checkout.`);

  // The stack runs, healthy, exactly as installation.env declares it.
  let before;
  try { before = await stackSnapshot(run, selector, env); } catch (error) { refuse(error.message.replace('an update needs', `${verb} needs`)); }
  const taken = portTaken({ run, env, dockerHost: selector.dockerHost });
  if ((await planChanges(selector, { run, env, taken })).changed.length) refuse('installation.env has an edit that is not applied yet: pnpm os:apply applies it, or undo it; then try again. Nothing was changed.');
  const current = await stackImageMetadata(run, selector, before.noticeos.image, env);
  let recorded = null;
  try { recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { /* none yet */ }
  if (recorded?.schema !== RECORD) recorded = null;

  let target;
  let staged;
  if (options.rollback) {
    if (!recorded || !fs.existsSync(previous)) refuse('no version before this one is recorded; there is nothing to roll back to.');
    target = await stackImageMetadata(run, selector, recorded.image, env);
    if (target.schema !== current.schema) refuse('the database schema changed since the version before; a rollback would run older code on it. Nothing was changed.');
    staged = previous;
  } else {
    const id = (await docker(['--host', selector.dockerHost, 'image', 'inspect', '--format', '{{.Id}}', installation.image], `Finding ${installation.image}`)).trim();
    target = await stackImageMetadata(run, selector, id, env);
    if (!target.revision || !target.schema) refuse(`${installation.image} carries no commit or schema; it is not a published NoticeOS image. Nothing was changed.`);
    if (target.id === current.id) {
      say(`Nothing to update: the app runs ${short(target.revision)}, the newest published version.`);
      return 0;
    }
    if (target.schema !== current.schema) {
      // Roles are set at the database's first start, so a change to them is operator maintenance.
      if (!fs.readFileSync(path.join(root, ROLES)).equals(fs.readFileSync(path.join(stack, ROLES)))) {
        refuse('the new version changes the Postgres roles; that is operator maintenance (db/postgres/host/README.md). Nothing was changed.');
      }
      const ready = await database(selector, { root, run, env });
      if (!ready.ok) refuse(`the new version carries database changes the database does not have yet: ${ready.line}. Then update again; it applies no migrations. Nothing was changed.`);
    }
    // Only update writes stack.next; one left by an interrupted run is replaced.
    fs.rmSync(next, { recursive: true, force: true });
    copyStack(root, next);
    staged = next;
  }

  // What changes, read from the staged definition as if it were in place.
  fs.mkdirSync(records, { recursive: true, mode: 0o700 });
  const nextEnv = path.join(records, 'next.env');
  const envText = fs.readFileSync(selector.envFile, 'utf8');
  stackAtomic(nextEnv, withImage(envText, target.id));
  const declared = async (files, envFile) => JSON.parse(await docker([...composePrefix({ ...selector, files, envFile }), 'config', '--format', 'json'], 'Reading the stack\'s declaration'));
  let changing;
  try {
    changing = changedServices(await declared(selector.files, selector.envFile),
      await declared(selector.files.map((file) => file.startsWith(`${stack}/`) ? staged + file.slice(stack.length) : file), nextEnv),
      { from: staged, to: stack });
  } finally { fs.rmSync(nextEnv, { force: true }); }
  const databases = changing.filter((name) => ['postgres', 'dolt'].includes(name));
  say(`${options.rollback ? 'Rolling back' : 'Updating'} ${selector.project} from ${short(current.revision)} to ${short(target.revision)}. Nothing has changed yet.`);
  say(`  The app${changing.includes('backup') ? ' and backup worker' : ''} run${changing.includes('backup') ? '' : 's'} the ${options.rollback ? 'earlier' : 'new'} image.`);
  if (databases.length) say(`  ${databases.join(', ')}: ${databases.length === 1 ? 'its' : 'their'} declaration changes; the app and backup worker stop while ${databases.length === 1 ? 'it returns' : 'they return'}.`);
  for (const name of changing.filter((name) => !['noticeos', 'backup', ...databases].includes(name))) say(`  ${name}: its declaration changes.`);
  say(`If a service does not become healthy, the stack returns to ${short(current.revision)}.`);
  const confirmed = options.confirm ?? (interactive ? await question(`Type ${verb} to do it, or press Enter to stop: `) : null);
  if (confirmed !== verb) {
    say(interactive ? 'Nothing was changed.' : `Nothing was changed. To do it: ${installation.launcher} ${verb} --confirm ${verb}`);
    return 0;
  }

  // A database image the other version names is fetched before anything stops.
  const model = await declared(selector.files.map((file) => file.startsWith(`${stack}/`) ? staged + file.slice(stack.length) : file), selector.envFile);
  for (const name of databases) {
    const image = model.services[name].image;
    if ((await run('docker', ['--host', selector.dockerHost, 'image', 'inspect', image], { env: ownEnv(env), timeoutMs: 20_000 })).code !== 0) {
      say(`Fetching ${image}.`);
      await docker(['--host', selector.dockerHost, 'pull', '--quiet', image], `Fetching ${image}`, { timeoutMs: 900_000 });
    }
  }

  await holdingStackLock(options.selectorFile, verb, async () => {
    const moves = options.rollback ? [[stack, spare], [previous, stack], [spare, previous]]
      : [...(fs.existsSync(previous) ? [[previous, spare]] : []), [stack, previous], [next, stack]];
    const done = [];
    let undone = false;
    const restore = () => {
      if (undone) return;
      undone = true;
      for (const [from, to] of [...done].reverse()) fs.renameSync(to, from);
      stackAtomic(selector.envFile, envText);
    };
    try {
      for (const [from, to] of moves) { fs.renameSync(from, to); done.push([from, to]); }
      stackAtomic(selector.envFile, withImage(envText, target.id));
      const plan = await planChanges(selector, { run, env, taken });
      const beyond = plan.changed.filter((name) => !changing.includes(name));
      if (beyond.length) refuse(`${beyond.join(', ')} would change beyond the plan; nothing was changed.`);
      await recreate(selector, plan, { previous: selector, restore, returned: ` The stack runs ${short(current.revision)} again, as it did before.`, run, env, out });
    } catch (error) {
      restore();
      // What was staged for the failed version is not kept.
      if (!options.rollback) fs.rmSync(next, { recursive: true, force: true });
      throw error;
    }
    if (!options.rollback) {
      fs.rmSync(spare, { recursive: true, force: true });
      stackAtomic(path.join(dir, LAUNCHER), fs.readFileSync(path.join(root, 'deploy', 'compose', LAUNCHER)));
      fs.chmodSync(path.join(dir, LAUNCHER), 0o755);
    }
    stackAtomic(recordFile, `${JSON.stringify({ schema: RECORD, image: current.id, revision: current.revision }, null, 2)}\n`);
    recordApplied(options.selectorFile, selector);
  });
  // The version before the one kept for rollback is not needed again.
  const stale = recorded?.image;
  if (!options.rollback && stale && ![target.id, current.id].includes(stale)) {
    await run('docker', ['--host', selector.dockerHost, 'image', 'rm', stale], { env: ownEnv(env), timeoutMs: 120_000 }).catch(() => null);
  }
  say(`${options.rollback ? 'Rolled back' : 'Updated'} to ${short(target.revision)}. ${installation.launcher} rollback returns to ${short(current.revision)}.`);
  return 0;
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  try {
    const parsed = parseOptions(argv);
    if (parsed.help) { out.write('usage: noticeos update [--confirm update] | noticeos rollback [--confirm rollback]\n'); return 0; }
    return await moveVersion(parsed, { out, ...options });
  } catch (error) {
    err.write(`noticeos ${argv.includes('--rollback') ? 'rollback' : 'update'}: ${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
