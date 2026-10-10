import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TIMED_OUT_CODE, runCommand } from './run-command.mjs';
import { lateWritingCommand } from './test-late-command.mjs';

// The one helper every script runs a command through.

// A helper that resolves on the child's 'exit' can return before the output
// has been read from the pipe (an applied-migration read that comes back
// { ok: true, names: [] } on a busy machine). Here a
// child exits at once while a process it started still holds stdout and
// writes later: only a helper that waits for the output to end sees both lines.
test('a command is collected once its output has ended, not merely once it exited', async () => {
  const result = await runCommand('sh', ['-c', 'echo early; (sleep 0.3; echo late) &']);
  assert.deepEqual(result, { code: 0, stdout: 'early\nlate\n', stderr: '', timedOut: false, error: null });
});

test('the stand-in the call-site tests use writes after it exits, and is read in full', async () => {
  const late = lateWritingCommand('late', { early: 'early\n', late: 'late\n', code: 3 });
  try {
    assert.deepEqual(await runCommand(late.bin, []), { code: 3, stdout: 'early\nlate\n', stderr: '', timedOut: false, error: null });
  } finally {
    late.remove();
  }
});

// Waiting for the output to end must not become waiting forever: a process
// the command left behind (git's ssh, a background job) can hold the pipe long
// after the command itself is gone.
test('at the timeout the command is killed, and a process holding its output does not hold the wait', async () => {
  const started = Date.now();
  const result = await runCommand('sh', ['-c', 'echo started; sleep 5 & sleep 5'], { timeoutMs: 300 });
  assert.equal(result.code, TIMED_OUT_CODE);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, 'started\n');
  assert.ok(Date.now() - started < 4_000, `the wait lasted ${Date.now() - started} ms`);
});

// A killed command must not read as exit 1, the answer "no" from git
// merge-base --is-ancestor, lsof and pgrep.
test('a command a signal ended reports 128 + the signal, never a plain 1', async () => {
  const result = await runCommand('sh', ['-c', 'kill -TERM $$']);
  assert.equal(result.code, 143);
  assert.equal(result.timedOut, false);
});

test('a command that cannot start resolves 127 with the spawn error, and never rejects', async () => {
  const result = await runCommand(path.join(tmpdir(), 'no-such-command-noticeos'), []);
  assert.equal(result.code, 127);
  assert.equal(result.error?.code, 'ENOENT');
  assert.equal(result.timedOut, false);
});

test('an inherited terminal collects nothing and keeps the exit code; onOutput sees both streams', async () => {
  assert.deepEqual(await runCommand('sh', ['-c', 'exit 3'], { inherit: true }), {
    code: 3,
    stdout: '',
    stderr: '',
    timedOut: false,
    error: null,
  });
  const pieces = [];
  const result = await runCommand('sh', ['-c', 'printf out; printf err >&2'], { onOutput: (text) => pieces.push(text) });
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.deepEqual([...pieces].sort(), ['err', 'out']);
});

test('explicit stdin reaches a real child byte-for-byte and closes at EOF while the default remains empty', async () => {
  const bytes = Buffer.concat([Buffer.from('Unicode Ω 🧭\r\nLine two\n\n'), Buffer.from([0, 255, 128])]);
  const script = "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(chunks).toString('base64'));process.stderr.write('done');process.exitCode=3})";
  const input = await runCommand(process.execPath, ['-e', script], { stdin: bytes });
  assert.equal(input.code, 3); assert.equal(input.stdout, bytes.toString('base64')); assert.equal(input.stderr, 'done');
  assert.equal(input.timedOut, false); assert.equal(input.error, null);
  const empty = await runCommand(process.execPath, ['-e', script]);
  assert.equal(empty.code, 3); assert.equal(empty.stdout, ''); assert.equal(empty.stderr, 'done');
  const text = await runCommand(process.execPath, ['-e', script], { stdin: 'String input Ω\n' });
  assert.equal(text.stdout, Buffer.from('String input Ω\n').toString('base64'));
});

test('a child closing stdin early retains its own exit status and streams instead of an EPIPE result', async () => {
  const result = await runCommand(process.execPath, ['-e', "process.stdin.destroy();process.stdout.write('early');process.stderr.write('refused');process.exit(7)"], { stdin: Buffer.alloc(1024 * 1024) });
  assert.equal(result.code, 7); assert.equal(result.stdout, 'early'); assert.equal(result.stderr, 'refused');
  assert.equal(result.error, null); assert.equal(result.timedOut, false);
  const missing = await runCommand(path.join(tmpdir(), 'no-such-stdin-command'), [], { stdin: 'input' });
  assert.equal(missing.code, 127); assert.equal(missing.error?.code, 'ENOENT');
});
