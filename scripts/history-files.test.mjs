import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { holdLock } from './history-files.mjs';

const busy = (pid) => new Error(`busy:${pid}`);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-history-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, '.lock') };
}

test('a contender that read the dead owner cannot unlink the replacement lock', async (t) => {
  const { file } = await fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  await fs.writeFile(file, JSON.stringify({ pid: exited.pid }));
  const read = fs.readFile.bind(fs);
  const remove = fs.rm.bind(fs);
  let reads = 0;
  let removals = 0;
  let readTogether;
  let acquired;
  const bothRead = new Promise((resolve) => { readTogether = resolve; });
  const firstAcquired = new Promise((resolve) => { acquired = resolve; });
  t.mock.method(fs, 'readFile', async (name, ...args) => {
    const value = await read(name, ...args);
    if (name === file && JSON.parse(value).pid === exited.pid) {
      if (++reads === 2) readTogether();
      await bothRead;
    }
    return value;
  });
  t.mock.method(fs, 'rm', async (name, ...args) => {
    // Reproduce the old race: the second stale removal happens only after
    // the first contender has acquired and returned its live lock.
    if (name === file && ++removals === 2) await firstAcquired;
    return remove(name, ...args);
  });
  const take = () => holdLock(file, busy).then((release) => { acquired(); return release; });
  const results = await Promise.allSettled([take(), take()]);
  const holders = results.filter((result) => result.status === 'fulfilled');
  assert.ok(holders.length <= 1, 'a stale reader must never displace the new holder');
  for (const holder of holders) await holder.value();
});

test('concurrent stale-lock recovery never admits two writers and permits the next run', async (t) => {
  const { file, dir } = await fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  for (let round = 0; round < 24; round++) {
    await fs.writeFile(file, JSON.stringify({ pid: exited.pid }));
    const outcomes = await Promise.allSettled([holdLock(file, busy), holdLock(file, busy)]);
    const holders = outcomes.filter((result) => result.status === 'fulfilled');
    assert.ok(holders.length <= 1, `round ${round} admitted ${holders.length} writers`);
    for (const result of outcomes) {
      if (result.status === 'rejected') assert.match(result.reason.message, /^busy:/u);
    }
    if (holders.length) {
      await assert.rejects(holdLock(file, busy), /^Error: busy:/u);
      await holders[0].value();
    }
    const next = await holdLock(file, busy);
    await next();
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('recovery removes only dead reservations and never removes a live owner', async (t) => {
  const { file, dir } = await fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  const abandoned = `${file}.${exited.pid}.00000000.tmp`;
  const live = `${file}.${process.pid}.11111111.tmp`;
  await fs.writeFile(file, JSON.stringify({ pid: exited.pid }));
  await fs.writeFile(abandoned, 'interrupted reservation');
  await fs.writeFile(live, 'active reservation');
  await fs.writeFile(path.join(dir, 'unrelated.tmp'), 'keep');
  await assert.rejects(holdLock(file, busy), /^Error: busy:/u);
  await assert.rejects(fs.stat(abandoned), { code: 'ENOENT' });
  assert.equal(await fs.readFile(live, 'utf8'), 'active reservation');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, exited.pid);
  await fs.rm(live);
  const release = await holdLock(file, busy);
  await assert.rejects(holdLock(file, busy), /^Error: busy:/u);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pid, process.pid);
  await release();
  assert.equal(await fs.readFile(path.join(dir, 'unrelated.tmp'), 'utf8'), 'keep');
});

test('releasing twice cannot remove the next writer’s lock', async (t) => {
  const { file } = await fixture(t);
  const first = await holdLock(file, busy);
  await first();
  const second = await holdLock(file, busy);
  await first();
  await assert.rejects(holdLock(file, busy), /^Error: busy:/u);
  await second();
});
