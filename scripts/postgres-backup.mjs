// A declared installation's operational database, read on the container's own
// socket. This module cannot start a service, apply a migration or infer a host.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localDocker } from './postgres-compose.mjs';

export const POSTGRES_DUMP_FILE = 'postgres/noticeos.dump';

export async function readBackupProfile(home, io = fs) {
  const file = path.join(home, 'postgres', 'profile.json');
  let profile;
  try {
    if (!(await io.lstat(file)).isFile()) throw new Error();
    profile = JSON.parse(await io.readFile(file, 'utf8'));
  } catch {
    throw new Error('Postgres backup requires this installation’s postgres/profile.json; declare its Compose project first.');
  }
  const keys = ['composeFile', 'port', 'project', 'secretsDir'];
  if (!profile || Array.isArray(profile) || Object.keys(profile).sort().join(',') !== keys.join(',')
    || typeof profile.project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(profile.project)
    || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535
    || ![profile.composeFile, profile.secretsDir].every((value) => typeof value === 'string'
      && path.isAbsolute(value) && !/[\r\n\0]/.test(value))) {
    throw new Error('Postgres backup profile must name one Compose project, absolute composeFile and secretsDir paths, and a port.');
  }
  if (!(await io.lstat(profile.composeFile)).isFile() || !(await io.lstat(profile.secretsDir)).isDirectory()) {
    throw new Error('Postgres backup profile must name an existing Compose file and secrets folder.');
  }
  return profile;
}

// Keep Docker's selected local context, but no app/PG secrets or Compose
// overrides. --env-file also excludes any adjacent .env from interpolation.
function dockerEnvironment(source, profile) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'XDG_CONFIG_HOME']) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  env.NOTICEOS_POSTGRES_SECRETS = profile.secretsDir;
  env.NOTICEOS_POSTGRES_PORT = String(profile.port);
  return env;
}

/** Bounded process output is used only for Docker context metadata. Dump
 * bytes go directly to an exclusive 0600 descriptor; stderr is never retained. */
function processCommand(launch, binary, args, { cwd, env, timeoutMs = 120_000, outputFd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = launch(binary, args, { cwd, env, stdio: ['ignore', outputFd ?? 'pipe', 'ignore'] });
    } catch {
      reject(new Error('Postgres backup command could not start'));
      return;
    }
    let stdout = '';
    if (outputFd === undefined) child.stdout?.on('data', (data) => {
      stdout = (stdout + data.toString()).slice(0, 4096);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Postgres backup command could not start'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Postgres backup command timed out'));
      else resolve({ code, stdout, stderr: '' });
    });
  });
}

export async function dumpPostgres(home, output, adapters = {}) {
  const io = adapters.fs ?? fs;
  const profile = await readBackupProfile(home, io);
  const env = dockerEnvironment(adapters.env ?? process.env, profile);
  const launch = adapters.spawn ?? spawn;
  const run = (binary, args, options) => processCommand(launch, binary, args, options);
  if (!await localDocker(run, { cwd: home, env })) {
    throw new Error('Postgres backup requires a local Docker context. No project was contacted.');
  }
  await io.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const handle = await io.open(output, 'wx', 0o600);
  try {
    const result = await processCommand(launch, 'docker', [
      'compose', '--env-file', '/dev/null', '-p', profile.project, '-f', profile.composeFile,
      'exec', '-T', '--user', 'postgres', 'postgres', 'pg_dump',
      '--host=/var/run/postgresql', '--username=postgres', '--dbname=noticeos',
      '--no-password', '--format=custom',
    ], { cwd: home, env, outputFd: handle.fd, timeoutMs: adapters.commandTimeoutMs });
    if (result.code !== 0) throw new Error('Postgres backup command failed');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const reader = await io.open(output, 'r');
  try {
    const magic = Buffer.alloc(5);
    const { bytesRead } = await reader.read(magic, 0, magic.length, 0);
    if (bytesRead !== 5 || magic.toString() !== 'PGDMP') throw new Error('Postgres backup is missing its custom-format header');
  } finally {
    await reader.close();
  }
}
