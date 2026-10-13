#!/usr/bin/env node
// An image installation's commands, inside the short-lived container its
// launcher (deploy/compose/noticeos) starts: the same os:* commands a
// checkout runs, aimed at the installation folder the launcher mounts at its
// own path, whose stack.json is the selector. It drops to the host user's IDs
// before anything is written, so the installation's files stay theirs, and a
// message that names a `pnpm os:*` command names the launcher instead.

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokedDirectly } from './invoked-directly.mjs';
import { imageInstallation } from './image-installation.mjs';
import { SELECTOR_FILE } from './installation-layout.mjs';

/** Each command: the script that runs it and the arguments that come first. */
export const COMMANDS = Object.freeze({
  setup: ['./os-setup.mjs', []],
  status: ['./stack-control.mjs', ['status']],
  logs: ['./stack-control.mjs', ['logs']],
  start: ['./stack-control.mjs', ['start']],
  stop: ['./stack-control.mjs', ['stop']],
  restart: ['./stack-control.mjs', ['restart']],
  backup: ['./stack-control.mjs', ['backup']],
  capacity: ['./stack-control.mjs', ['capacity']],
  'run-job': ['./stack-control.mjs', ['run-job']],
  collect: ['./stack-control.mjs', ['collect']],
  apply: ['./stack-apply.mjs', []],
  update: ['./image-update.mjs', []],
  rollback: ['./image-update.mjs', ['--rollback']],
  migrate: ['./os-migrate.mjs', []],
});
const SOCKET = '/var/run/docker.sock';

/** Become the host user the launcher names, keeping the Docker socket's group. */
export function becomeHostUser(env, { proc = process, io = fs } = {}) {
  const uid = Number(env.NOTICEOS_HOST_UID);
  const gid = Number(env.NOTICEOS_HOST_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) throw new Error('The launcher named no host user.');
  if (proc.getuid() !== 0 || uid === 0) return;
  proc.setgroups([...new Set([gid, io.statSync(SOCKET).gid])]);
  proc.setgid(gid);
  proc.setuid(uid);
}

/** `stream`, with each `pnpm os:<command> --` it writes naming `launcher` instead. */
export function naming(stream, launcher) {
  return {
    isTTY: stream.isTTY,
    write: (text) => stream.write(String(text).replace(/pnpm os:([a-z-]+)(?: --(?= |$))?/gmu, `${launcher} $1`)),
  };
}

export async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr,
  load = (file) => import(file), become = becomeHostUser, home = () => path.join(os.tmpdir(), `noticeos-home-${process.getuid?.() ?? 0}`) } = {}) {
  const [verb, ...rest] = argv;
  const command = Object.hasOwn(COMMANDS, verb ?? '') ? COMMANDS[verb] : null;
  if (!command) {
    err.write(`noticeos: name a command: ${Object.keys(COMMANDS).join(', ')}.\n`);
    return 2;
  }
  let installation;
  try {
    installation = imageInstallation(env);
    if (!installation) throw new Error('This runs inside the container the noticeos launcher starts.');
    become(env);
  } catch (error) {
    err.write(`noticeos: ${error.message}\n`);
    return 1;
  }
  // Docker keeps its client settings in HOME; the host's is not here.
  env.HOME = home();
  fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  const [script, first] = command;
  const { main: run } = await load(script);
  return run([...first, ...rest, '--config', path.join(installation.dir, SELECTOR_FILE)],
    { env, out: naming(out, installation.launcher), err: naming(err, installation.launcher) });
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
