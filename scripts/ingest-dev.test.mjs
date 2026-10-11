import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doorHeldMessage, ingestDev } from './ingest-dev.mjs';
import { DEFAULT_DOOR } from './ingest-door.mjs';

// A held ingest door prevents a second runtime over the same local R2 metadata.
// Every network probe and child process in this suite is injected.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A wrangler that records instead of spawning. */
function stubWrangler(result = { code: 0 }) {
  const calls = [];
  const start = async (args) => {
    calls.push(args);
    return result;
  };
  return { start, calls };
}

function silence(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
}

test('a held door refuses, and wrangler is never spawned', async (t) => {
  silence(t);
  const { start, calls } = stubWrangler();

  const code = await ingestDev({ start, held: async () => true });

  assert.equal(code, 1);
  // The whole interlock: not one wrangler process, because the process IS the
  // second runtime. Refusing after spawning would be no refusal at all — and a
  // `wrangler dev` that got as far as binding has already opened the store.
  assert.deepEqual(calls, []);
});

test('the refusal names what is holding the store and what to do instead', () => {
  const message = doorHeldMessage(DEFAULT_DOOR);
  assert.match(message, /refusing to start/);
  assert.match(message, /127\.0\.0\.1:8791/);
  assert.match(message, /pnpm os:status/);
  // The operator usually wants the ingest, not a second copy of it — under the runner
  // it is already running inside the Tower's runtime, on this very port. Without
  // that sentence the refusal reads as "you are stuck".
  assert.match(message, /inside the Tower's runtime/);
  // …and the escape hatch is still an escape hatch: it says how to take it.
  assert.match(message, /stop the OS first/);
  assert.match(message, /pnpm --filter @noticeos\/ingest dev/);
  assert.match(message, /Nothing was started here/);
});

test('the refusal is about the port, whatever door it is aimed at', () => {
  assert.match(doorHeldMessage('http://127.0.0.1:9999'), /127\.0\.0\.1:9999/);
});

// The question is NOT "can I bind my own port". Standalone `wrangler dev` binds
// 8787 and the door is 8791; the shared thing is local R2 metadata, and the process
// holding it answers on the door. A self-port check would pass happily while
// the runner served the store, which is the accident this file exists to prevent.
test('the door it probes is the ingest door, not its own dev port', async (t) => {
  silence(t);
  const asked = [];
  const { start } = stubWrangler();

  await ingestDev({
    start,
    held: async (door) => {
      asked.push(door);
      return false;
    },
  });

  assert.deepEqual(asked, [DEFAULT_DOOR]);
  assert.match(DEFAULT_DOOR, /8791/);

  const source = readFileSync(path.join(SCRIPTS_DIR, 'ingest-dev.mjs'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(code, /8787/, 'probing its own dev port is not the guard this file needs');
});

test('a free door starts wrangler, and passes extra flags through', async (t) => {
  silence(t);
  const { start, calls } = stubWrangler({ code: 0 });

  const code = await ingestDev({ start, held: async () => false, args: ['--test-scheduled'] });

  assert.equal(code, 0);
  assert.deepEqual(calls, [['--test-scheduled']]);
});

test('a wrangler failure is the exit code, not a silent success', async (t) => {
  silence(t);
  const failed = stubWrangler({ code: 3 });
  assert.equal(await ingestDev({ start: failed.start, held: async () => false }), 3);

  // A spawn that never started (no pnpm, no wrangler) still fails closed —
  // including the case where the spawn error arrives with a zero-ish code.
  const unspawnable = stubWrangler({ code: 0, error: 'spawn pnpm ENOENT' });
  assert.equal(await ingestDev({ start: unspawnable.start, held: async () => false }), 1);
});

// The refusal only holds if the manifest entry actually routes through here.
// scripts/no-second-runtime.test.mjs enforces the general rule; this pins the
// ingest's own dev entry by name, and that it is not a bare wrangler line.
test('the ingest dev entry point routes through this script', () => {
  const repoRoot = path.resolve(SCRIPTS_DIR, '..');
  const ingest = JSON.parse(
    readFileSync(path.join(repoRoot, 'workers', 'ingest', 'package.json'), 'utf8'),
  );

  assert.match(ingest.scripts.dev, /scripts\/ingest-dev\.mjs/);
  assert.doesNotMatch(ingest.scripts.dev, /wrangler/);
  assert.doesNotMatch(ingest.scripts.dev, /--persist-to/);
});
