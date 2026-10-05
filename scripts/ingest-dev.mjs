#!/usr/bin/env node
// Run the ingest Worker standalone only while the ingest door is free.
// Postgres holds the operational data; local R2 metadata still belongs to one
// workerd runtime. Probe the existing runtime's door, not the standalone port,
// before spawning a second process over that same persistence directory.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorIsHeld } from './ingest-door.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_PERSIST = path.join(REPO_ROOT, '.wrangler', 'state');

const log = (msg) => console.log(`[ingest-dev] ${msg}`);
const fail = (msg) => console.error(`[ingest-dev] ${msg}`);

/**
 * The one wrangler invocation this file exists to gate.
 *
 * Run through `@noticeos/ingest` so it picks up that workspace's
 * `wrangler.jsonc` — bindings, secrets and `triggers.crons` — exactly as the bare
 * `pnpm dev` line did when it lived in that manifest.
 *
 * `--persist-to` is ABSOLUTE, so the store is the repo's own whatever directory
 * the operator typed the command in (the old relative `../../.wrangler/state`
 * only worked because pnpm happened to run it from workers/ingest).
 *
 * stdio is inherited: `wrangler dev` is an interactive, long-lived process with a
 * key-driven console, and that session belongs to the operator exactly as it did
 * when this was a bare pnpm script.
 */
function wranglerDev(extraArgs = []) {
  return new Promise((resolve) => {
    const proc = spawn(
      'pnpm',
      [
        '--filter',
        '@noticeos/ingest',
        'exec',
        'wrangler',
        'dev',
        '--persist-to',
        STATE_PERSIST,
        ...extraArgs,
      ],
      { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' },
    );
    proc.on('error', (err) => resolve({ code: 1, error: err.message }));
    proc.on('exit', (code) => resolve({ code: code ?? 0 }));
  });
}

/** What the operator is told when the OS is up. Named and exported so the test
 * pins the sentence, not just the exit code: the value of a refusal is that it
 * says what to do next — and here "what to do next" is usually "nothing, the
 * ingest you want is already running inside os:up". */
export function doorHeldMessage(door = DEFAULT_DOOR) {
  const { host } = new URL(door);
  return [
    `refusing to start: something already answers on ${host}, this repo's ingest door.`,
    '  A second runtime could open the same local R2 metadata.',
    "  Under `pnpm os:up`, the ingest already runs inside the Tower's runtime.",
    '  Use its ingest door and `pnpm os:cron` for scheduled work.',
    '  For standalone development, stop the OS first, then run `pnpm --filter @noticeos/ingest dev`.',
    '  For a managed service, use the approved service controls; do not kill an unknown process.',
    '  Nothing was started here.',
  ].join('\n');
}

/**
 * Start standalone `wrangler dev`, or refuse and say why.
 *
 * Returns the exit code rather than calling process.exit, so the refusal is
 * testable. `start` and `held` are injectable for the same reason — a test must
 * be able to prove that a held door means wrangler is never spawned at all,
 * which is the entire point of the file.
 */
export async function ingestDev({
  start = wranglerDev,
  held = doorIsHeld,
  door = DEFAULT_DOOR,
  args = [],
} = {}) {
  if (await held(door)) {
    fail(doorHeldMessage(door));
    return 1;
  }

  log('nothing holds the local store — starting a standalone `wrangler dev` on the ingest.');
  log('(under `pnpm os:up` this Worker runs inside the Tower runtime instead; this is the isolation path.)');
  const result = await start(args);
  if (result.error) {
    fail(`wrangler could not be started — ${result.error}`);
    return result.code === 0 ? 1 : result.code;
  }
  return result.code;
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  // exitCode, not process.exit: the refusal above is the whole product of this
  // script, and a hard exit can cut its last lines off a piped stdout.
  process.exitCode = await ingestDev({ args: process.argv.slice(2) });
}
