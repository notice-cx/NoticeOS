// runner/log.mjs — the local runner's one combined log: every line to stdout
// and to `.local/logs/os-up.log`, redacted before it reaches disk, bounded per
// line, and rotated at a byte bound. `pnpm os:logs` reads it back
// (scripts/os-control.mjs); nothing else should need its path.

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { redactLogText } from '../os-log.mjs';
import { LOG_FILE } from './config.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Logging — every line is `<iso-utc> <tag> <text>` to both stdout and the log
// file. Child output is tagged [ingest]/[tower]; our own lines are [os-up].
// ─────────────────────────────────────────────────────────────────────────────
let logStream = null;
let logBytes = 0;
let logRollover = null;
let logQueue = [];
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_ROTATIONS = 5;
export const LOG_LINE_MAX_CHARS = 64 * 1024;

export function ts() {
  return new Date().toISOString();
}

export function writeLine(tag, line) {
  const redacted = redactLogText(line);
  const bounded =
    redacted.length > LOG_LINE_MAX_CHARS
      ? `${redacted.slice(0, LOG_LINE_MAX_CHARS)}… [line truncated]`
      : redacted;
  const out = `${ts()} ${tag} ${bounded}`;
  process.stdout.write(out + '\n');
  writeLogChunk(`${out}\n`);
}

export function log(level, msg) {
  writeLine('[os-up]', `${level} ${msg}`);
}

export async function rotateLogFile(file = LOG_FILE, { maxBytes = LOG_MAX_BYTES, keep = LOG_ROTATIONS } = {}) {
  let size = 0;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;
  try {
    await fs.unlink(`${file}.${keep}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      await fs.rename(`${file}.${index}`, `${file}.${index + 1}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await fs.rename(file, `${file}.1`);
  return true;
}

function createLogStream() {
  logStream = createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.on('error', () => {
    // Swallow — logging is best-effort; the console still gets the line.
  });
}

export async function openLog() {
  await rotateLogFile();
  try {
    logBytes = (await fs.stat(LOG_FILE)).size;
  } catch {
    logBytes = 0;
  }
  createLogStream();
}

/**
 * Resolves once every line written so far is in the file, then closes it: what
 * a refusal awaits before it exits. The managed service's stdout goes nowhere,
 * and a line still queued behind a stream that is opening dies with the
 * process (bead ro-ujb9.76.7.2).
 */
export async function closeLog() {
  await logRollover;
  const closing = logStream;
  logStream = null;
  if (closing) await new Promise((resolve) => closing.end(resolve));
}

function writeLogChunk(chunk) {
  if (logRollover) {
    logQueue.push(chunk);
    return;
  }
  const bytes = Buffer.byteLength(chunk);
  if (logStream && logBytes + bytes < LOG_MAX_BYTES) {
    try {
      logStream.write(chunk);
      logBytes += bytes;
    } catch {
      // A broken log stream must never take the runner down.
    }
    return;
  }
  if (!logStream) return;

  logQueue.push(chunk);
  const closing = logStream;
  logStream = null;
  logRollover = new Promise((resolve) => closing.end(resolve))
    .then(() => rotateLogFile())
    .then(() => {
      createLogStream();
      logBytes = 0;
      const queued = logQueue;
      logQueue = [];
      for (const held of queued) {
        logStream.write(held);
        logBytes += Buffer.byteLength(held);
      }
    })
    .catch(() => {
      // The console is still live; do not let log hygiene stop the OS.
      logQueue = [];
    })
    .finally(() => {
      logRollover = null;
    });
}
