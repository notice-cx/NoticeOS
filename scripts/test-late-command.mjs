// test-late-command.mjs — a stand-in command whose output outlives its exit,
// for the tests that pin bead ro-ujb9.185: every script reads a command to the
// END of its output (scripts/run-command.mjs), not merely until it exited.
//
// The command prints `early`, exits at once with `code`, and leaves a process
// it started to print `late` 0.3 s later on the same stdout. Code that stops
// reading at 'exit' sees `early` alone, or nothing; code that waits for the
// output to end sees both.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/** Writes the command as `<fresh folder>/<name>`; returns the folder, the
 * command's path and a cleanup. */
export function lateWritingCommand(name, { early, late, code = 0 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'late-command-'));
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' ${quote(early)}\n(sleep 0.3; printf '%s' ${quote(late)}) &\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs `fn` with PATH set to `dir` and the two system folders alone, so a
 * command looked up by name finds the stand-in first, and a tool such as pnpm,
 * which lives in neither system folder, can never be the real one. */
export async function withPathOf(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = [dir, '/bin', '/usr/bin'].join(path.delimiter);
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}
