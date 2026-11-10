// The loopback port a test's own task server (Dolt in Docker) listens on.
//
// A port the kernel picked for a probe and then let go goes back into the pool
// it hands to the next `listen(0)` or outbound connection from any process,
// and the demo's Ntasks and the test Postgres ask for such ports in the same
// seconds the task server takes to start. So the port comes from a block below
// the kernel's own range, which the kernel never hands out, and a listening
// lock port beside it holds it for the test's lifetime: only one process can
// hold a lock, and a process that dies releases its lock with it.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import net from 'node:net';
import { runCommand } from '../run-command.mjs';

/** Task server ports are [low, low + size); each one's lock port is size above it. */
export const TASK_PORT_BLOCK = Object.freeze({ low: 20000, size: 4000 });

/** The [first, last] ports a Linux kernel picks from; null elsewhere (macOS's
 * default range starts at 49152). */
export function kernelPortRange() {
  if (process.platform !== 'linux') return null;
  return fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/u).map(Number);
}

const listening = port => new Promise(resolve => {
  const server = net.createServer();
  server.unref();
  server.once('error', () => resolve(null));
  server.listen(port, '127.0.0.1', () => resolve(server));
});
const closed = server => new Promise(resolve => server.close(() => resolve()));

/** Reserve a task server port no other process holds or listens on. Resolves
 * `{ port, release }`; `release()` frees it for the next reservation. `start`
 * is the first port tried; left out, a random one in the block. */
export async function reserveTaskPort({ block = TASK_PORT_BLOCK, start } = {}) {
  const range = kernelPortRange();
  assert.ok(range === null || block.low + 2 * block.size <= range[0],
    `Task server ports ${block.low}-${block.low + 2 * block.size - 1} overlap the kernel's ports ${range?.join('-')}`);
  const first = (start ?? block.low + randomInt(block.size)) - block.low;
  for (let i = 0; i < block.size; i += 1) {
    const port = block.low + (first + i) % block.size;
    const lock = await listening(port + block.size);
    if (!lock) continue;
    const probe = await listening(port);
    if (!probe) { await closed(lock); continue; }
    await closed(probe);
    let release;
    return Object.freeze({ port, release: () => (release ??= closed(lock)) });
  }
  throw new Error(`No task server port is free in ${block.low}-${block.low + block.size - 1}`);
}

/** What listens on 127.0.0.1:`port`, for a refusal's message. */
export async function portListener(port) {
  const [command, args] = process.platform === 'linux' ? ['ss', ['-Hltnp', `sport = :${port}`]]
    : ['lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN']];
  const reply = await runCommand(command, args, { timeoutMs: 5000 });
  const found = reply.stdout.trim().replace(/\s+/gu, ' ');
  return found ? `${command} shows: ${found}` : `${command} shows no listener on ${port} (exit ${reply.code})`;
}
