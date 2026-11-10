import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { kernelPortRange, reserveTaskPort, TASK_PORT_BLOCK } from './test-fixtures/task-port.mjs';

const MODULE = new URL('./test-fixtures/task-port.mjs', import.meta.url).href;

/** Another test file's process: it reserves a task server port, prints it and
 * holds it until its stdin ends. */
async function otherTestProcess() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { reserveTaskPort } = await import(${JSON.stringify(MODULE)});
    const { port } = await reserveTaskPort();
    process.stdout.write(port + '\\n');
    process.stdin.resume();`], { stdio: ['pipe', 'pipe', 'inherit'] });
  let printed = '';
  for await (const chunk of child.stdout) { printed += chunk; if (printed.includes('\n')) break; }
  return { child, port: Number(printed.trim()) };
}

test('two test processes never get one task server port, and the kernel never hands one out', async () => {
  const other = await otherTestProcess();
  try {
    assert.ok(Number.isInteger(other.port), 'the other process reserved a port');
    const mine = await reserveTaskPort({ start: other.port });
    try {
      assert.notEqual(mine.port, other.port);
      const range = kernelPortRange();
      for (const port of [other.port, mine.port]) {
        assert.ok(port >= TASK_PORT_BLOCK.low && port < TASK_PORT_BLOCK.low + TASK_PORT_BLOCK.size);
        if (range) assert.ok(port + TASK_PORT_BLOCK.size < range[0], `${port} lies below the kernel's ${range.join('-')}`);
      }
    } finally { await mine.release(); }
    const again = await reserveTaskPort({ start: mine.port });
    try { assert.equal(again.port, mine.port, 'A released port is free again'); } finally { await again.release(); }
  } finally {
    if (other.child.exitCode === null && other.child.signalCode === null) {
      other.child.kill();
      await once(other.child, 'exit');
    }
  }
  const after = await reserveTaskPort({ start: other.port });
  try { assert.equal(after.port, other.port, 'A port is free again once the process holding it ends'); } finally { await after.release(); }
});
