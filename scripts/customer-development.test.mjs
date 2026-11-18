import assert from 'node:assert/strict';
import test from 'node:test';
import { customerSourceRevision, runLiveCustomer } from './customer-development.mjs';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the live build notices checkout edits and ignores installed and generated runtime state', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-source-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['apps/tower/src', 'workers/ingest', 'packages', 'scripts', 'config', 'docs', 'apps/tower/node_modules', '.local']) {
    mkdirSync(path.join(root, name), { recursive: true });
  }
  const save = (name, text) => writeFileSync(path.join(root, name), text);
  const source = 'apps/tower/src/fixture.ts';
  const cache = new Map();
  save(source, 'export const version = 1;');
  const before = customerSourceRevision(root, cache);
  save('apps/tower/node_modules/hidden.js', 'not an input');
  save('.local/private.json', '{"fixture":true}');
  utimesSync(path.join(root, source), 1, 1);
  assert.equal(customerSourceRevision(root, cache), before);
  save(source, 'export const version = 2;');
  assert.notEqual(customerSourceRevision(root, cache), before);
});

test('a source refresh keeps the last active app on broken edits and opens only one runtime at a time', async () => {
  const events = [];
  const stopping = Promise.withResolvers();
  const changes = ['compile-error', 'startup-error', 'published'];
  let revision = 'initial', active;
  const status = await runLiveCustomer({
    sourceRevision: () => revision,
    async build(_state, current) {
      events.push(`build ${current} while ${active ?? 'stopped'}`);
      if (current === 'compile-error') throw new Error('Synthetic source error.');
      return { artifact: current, dispose: () => events.push(`discard ${current}`) };
    },
    async launch(artifact) {
      assert.equal(active, undefined);
      events.push(`start ${artifact}`);
      if (artifact === 'startup-error') throw new Error('Synthetic startup error.');
      active = artifact;
      return { whenLost: new Promise(() => {}), async close() { events.push(`close ${active}`); active = undefined; } };
    },
    async wait() {
      if (changes.length > 0) revision = changes.shift();
      else stopping.resolve();
    },
    stop: stopping.promise,
    out: { write() {} },
  });
  assert.equal(status, 0);
  assert.equal(active, undefined);
  assert.deepEqual(events, [
    'build initial while stopped', 'start initial',
    'build compile-error while initial',
    'build startup-error while initial', 'close initial', 'start startup-error', 'start initial', 'discard startup-error',
    'build published while initial', 'close initial', 'start published', 'discard initial', 'close published', 'discard published',
  ]);
});
