import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import {
  LOG_LINE_MAX_CHARS,
  LOG_MAX_BYTES,
  LOG_ROTATIONS,
  log,
  rotateLogFile,
  writeLine,
} from './runner/log.mjs';

// scripts/runner/log.mjs (bead ro-ujb9.22): the runner's one combined log.
// These tests never open the log file itself (openLog), so they write nothing
// into this checkout's .local/: a line goes to stdout only, which is captured.

/** Every stdout write `fn` makes, with stdout restored however it ends. */
function captureStdout(fn) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return written;
}

test('a line is timestamped, tagged, and redacted before anyone sees it', () => {
  const [line] = captureStdout(() => writeLine('[tower]', 'sent Bearer abc.def-123 to the door'));
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[tower\] sent Bearer \[REDACTED\] to the door\n$/u);
  assert.doesNotMatch(line, /abc\.def-123/u);
});

test("the runner's own lines carry the [os-up] tag and their level", () => {
  const [line] = captureStdout(() => log('WARN', 'hub down'));
  assert.match(line, / \[os-up\] WARN hub down\n$/u);
});

test('a runaway line is cut at the bound and says so', () => {
  const [line] = captureStdout(() => writeLine('[tower]', 'x'.repeat(LOG_LINE_MAX_CHARS + 10)));
  assert.ok(line.endsWith(`${'x'.repeat(10)}… [line truncated]\n`));
  assert.ok(line.length < LOG_LINE_MAX_CHARS + 100);
});

test('rotation moves nothing below the bound, and a missing log is not an error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-log-'));
  try {
    const file = path.join(dir, 'os-up.log');
    assert.equal(await rotateLogFile(file), false);
    writeFileSync(file, 'small');
    assert.equal(await rotateLogFile(file, { maxBytes: 100, keep: 2 }), false);
    assert.equal(readFileSync(file, 'utf8'), 'small');
    assert.equal(existsSync(`${file}.1`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation at the bound keeps a fixed number of old logs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-log-'));
  try {
    const file = path.join(dir, 'os-up.log');
    writeFileSync(file, 'newest');
    writeFileSync(`${file}.1`, 'older');
    writeFileSync(`${file}.2`, 'oldest');
    assert.equal(await rotateLogFile(file, { maxBytes: 3, keep: 2 }), true);
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'newest');
    assert.equal(readFileSync(`${file}.2`, 'utf8'), 'older');
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('os-up.mjs still offers the same log bounds and rotation', () => {
  assert.equal(osUp.rotateLogFile, rotateLogFile);
  assert.equal(osUp.LOG_MAX_BYTES, LOG_MAX_BYTES);
  assert.equal(osUp.LOG_ROTATIONS, LOG_ROTATIONS);
  assert.equal(osUp.LOG_LINE_MAX_CHARS, LOG_LINE_MAX_CHARS);
});
