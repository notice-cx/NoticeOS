#!/usr/bin/env node
// The demo's own Ntasks, built from the commit deploy/demo/ntasks.json pins:
// the Worker bundle its ntasks service runs and the seed, load and provision
// tools setup runs. The demo image builds it this way (deploy/demo/Dockerfile),
// and so do the tests that run the demo's Ntasks.
//
//   node scripts/demo-ntasks-build.mjs --out <new folder>
//
// Clones the pinned repository into the new folder, checks out the pinned
// commit, installs its locked dependencies and builds it. Prints only
// NOTICEOS_NTASKS_ROOT=<folder> on stdout; progress goes to stderr.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { invokedDirectly } from './invoked-directly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NTASKS_PIN = path.join(ROOT, 'deploy', 'demo', 'ntasks.json');
const REPOSITORY = 'https://github.com/notice-cx/Ntasks.git';

/** The pinned repository and commit, refused unless they are exactly Ntasks's public repository and one full commit. */
export function readNtasksPin(text = fs.readFileSync(NTASKS_PIN, 'utf8')) {
  const pin = JSON.parse(text);
  if (!pin || typeof pin !== 'object' || Object.keys(pin).sort().join() !== 'commit,repository'
    || pin.repository !== REPOSITORY || typeof pin.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(pin.commit)) {
    throw new Error('deploy/demo/ntasks.json names no exact Ntasks commit.');
  }
  return Object.freeze({ repository: pin.repository, commit: pin.commit });
}

function run(command, args, cwd) {
  // The tools' own output goes to stderr: stdout carries only the one line a CI env file takes.
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 2, 2],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', DO_NOT_TRACK: '1' } });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} did not finish.`);
}

/** Clones and builds the pinned Ntasks into `out`, which must not exist yet. */
export function buildNtasks(out, pin = readNtasksPin()) {
  if (!path.isAbsolute(out) || fs.existsSync(out)) throw new Error('Name a new absolute folder for the Ntasks build.');
  run('git', ['clone', '--quiet', '--filter=blob:none', pin.repository, out], path.dirname(out));
  run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', pin.commit], out);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: out, encoding: 'utf8' }).stdout.trim();
  if (head !== pin.commit) throw new Error('The Ntasks checkout is not the pinned commit.');
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--no-runtime'], out);
  run('pnpm', ['run', 'build'], out);
  if (!fs.existsSync(path.join(out, 'dist', 'index.js'))) throw new Error('The Ntasks build wrote no Worker bundle.');
  return out;
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
    if (!values.out) throw new Error('usage: demo-ntasks-build.mjs --out <new folder>');
    process.stdout.write(`NOTICEOS_NTASKS_ROOT=${buildNtasks(path.resolve(values.out))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
