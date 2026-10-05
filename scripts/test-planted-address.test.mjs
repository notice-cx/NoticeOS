import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filesHolding, processTree } from './test-planted-address.mjs';

const exited = () => Object.assign(new Error('not found'), { status: 1 });

test('the secret scan tolerates a listed file disappearing and still finds remaining leaks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-secret-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gone = path.join(root, 'registry');
  const leak = path.join(root, 'output');
  const allowed = path.join(root, 'declared-secret');
  for (const file of [gone, leak, allowed]) fs.writeFileSync(file, 'synthetic-planted-value');
  const read = [];
  const found = filesHolding('synthetic-planted-value', [root], { except: [allowed], io: {
    readdirSync: fs.readdirSync,
    readFileSync(file) {
      read.push(file);
      if (file === gone) fs.unlinkSync(file);
      return fs.readFileSync(file);
    },
  } });
  assert.deepEqual(found, [leak]);
  assert.ok(read.includes(gone));
  assert.ok(!read.includes(allowed));
  assert.deepEqual(filesHolding('synthetic-planted-value', [path.join(root, 'missing')]), []);
});

test('the secret scan reports directory and file read failures other than absence', () => {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const error = Object.assign(new Error('synthetic read failure'), { code });
    assert.throws(() => filesHolding('synthetic', ['/synthetic'], { io: {
      readdirSync() { throw error; },
      readFileSync() { assert.fail('no file was listed'); },
    } }), value => value === error);
    assert.throws(() => filesHolding('synthetic', ['/synthetic'], { io: {
      readdirSync() { return [{ name: 'file', isDirectory: () => false, isFile: () => true }]; },
      readFileSync() { throw error; },
    } }), value => value === error);
  }
});

test('process argument reads name only the owned root and children discovered beneath it', () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, args]);
    const pid = Number(args[1]);
    if (command === 'ps') {
      assert.deepEqual(args, ['-p', String(pid), '-o', 'pid=,ppid=,args=']);
      assert.ok([101, 202, 303].includes(pid));
      return `${pid} ${pid === 101 ? 1 : pid === 202 ? 101 : 202} node owned-${pid}\n`;
    }
    assert.equal(command, 'pgrep');
    assert.deepEqual(args, ['-P', String(pid)]);
    if (pid === 303) throw exited();
    return `${pid === 101 ? 202 : 303}\n`;
  };
  assert.deepEqual(processTree(101, { exec }).map(row => row.pid), [101, 202, 303]);
  assert.equal(calls.length, 6);
});

test('failed inspection is never mistaken for an empty secret-free process tree', () => {
  for (const error of [exited(), Object.assign(new Error('permission denied'), { code: 'EPERM' })]) {
    assert.throws(() => processTree(101, { exec() { throw error; } }), value => value === error);
  }
  assert.throws(() => processTree(101, { exec(command) {
    if (command === 'ps') return '101 1 node own\n';
    throw Object.assign(new Error('permission denied'), { status: 2 });
  } }), /permission denied/u);
  for (const diagnostic of [{ stderr: 'permission denied' }, { stdout: 'invalid query' }]) {
    assert.throws(() => processTree(101, { exec(command) {
      if (command === 'ps') return '101 1 node own\n';
      throw Object.assign(exited(), diagnostic);
    } }));
    assert.throws(() => processTree(101, { exec(command, args) {
      if (command === 'pgrep') return '202\n';
      if (args[1] === '101') return '101 1 node own\n';
      throw Object.assign(exited(), diagnostic);
    } }));
  }
});

test('a child that already exited is omitted while the root remains verified', () => {
  const rows = processTree(101, { exec(command, args) {
    if (command === 'pgrep') return '202\n';
    if (args[1] === '202') throw exited();
    return '101 1 node own\n';
  } });
  assert.deepEqual(rows, [{ pid: 101, ppid: 1, args: 'node own' }]);
});

test('invalid roots, malformed discoveries and changed child identities fail closed', () => {
  for (const pid of [0, -1, NaN, '101', 1.5]) assert.throws(() => processTree(pid, { exec() { assert.fail('invalid root must not query'); } }));
  for (const children of ['', '101\n', '202\n202\n', 'no-pid\n']) {
    assert.throws(() => processTree(101, { exec(command) {
      return command === 'ps' ? '101 1 node own\n' : children;
    } }));
  }
  assert.throws(() => processTree(101, { exec(command, args) {
    if (command === 'pgrep') return '202\n';
    return args[1] === '101' ? '101 1 node own\n' : '202 999 node changed-parent\n';
  } }), /identity changed/u);
});
