import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './test-config-isolation.mjs';

// Module-level state in the ingest Worker is registered or declared pure. The
// ingest suite reuses one Workers runtime from file to file rather than
// evaluating every module again for each one: it forgets what the registered
// modules hold instead (workers/ingest/src/isolate-state.ts,
// test/clean-start.ts). State nobody registered would carry from one test
// file into the next, so a new piece of it stops here until it is registered
// or named a pure cache below.

const SRC = path.join(REPO_ROOT, 'workers', 'ingest', 'src');

/** Registered with isolateState(...) in the same file. */
const REGISTERED = {
  'config-store.ts': ['caches'],
  // laneTokens is never forgotten on purpose: release tokens keep rising, so a
  // run still going from before cannot free a later run's lane.
  'dataforseo-dumps.ts': ['lane', 'laneTokens'],
  'ga4-realtime.ts': ['sharedTokenCache'],
};

/** Caches whose content any isolate would build the same way. */
const PURE = {
  'calendar.ts': { zoneFormatters: 'one Intl formatter per time zone, the same in every isolate' },
};

/** Top-level `let`s, and top-level collections the file changes. */
function moduleState(source) {
  const names = [...source.matchAll(/^let\s+(\w+)/gmu)].map((match) => match[1]);
  for (const [, name] of source.matchAll(/^const\s+(\w+)(?:\s*:[^=\n]+)?\s*=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet)\b|\[\])/gmu)) {
    if (new RegExp(`\\b${name}\\.(?:set|add|delete|clear|push|splice|pop|shift|unshift)\\(`, 'u').test(source)) names.push(name);
  }
  return names.sort();
}

test('every piece of ingest module state is registered to be forgotten, or is a pure cache', () => {
  const found = {};
  for (const file of readdirSync(SRC).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort()) {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    const names = moduleState(source);
    if (file === 'isolate-state.ts') continue;
    if (names.length) found[file] = names;
    if (REGISTERED[file]) assert.match(source, /\bisolateState\(/u, `${file} registers its state with isolateState(...)`);
  }
  const declared = Object.fromEntries([...new Set([...Object.keys(REGISTERED), ...Object.keys(PURE)])].sort()
    .map((file) => [file, [...(REGISTERED[file] ?? []), ...Object.keys(PURE[file] ?? {})].sort()]));
  assert.deepEqual(found, declared,
    'module-level state in workers/ingest/src must be registered with isolateState(...) beside its declaration ' +
    '(and listed in REGISTERED here), or listed in PURE with why every isolate would hold the same');
});

test('the check sees the shapes of state it guards', () => {
  assert.deepEqual(moduleState('let a = 1;\nconst b = new Map();\nb.set(1, 2);\nconst c = new Set([1]);\nconst d: string[] = [];\nd.push("x");\n  let inner = 2;\n'),
    ['a', 'b', 'd']);
});
