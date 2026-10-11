// run-command.mjs — run one command and read it to the END of its output.
//
// The scripts that wait on a command run it through here: the runner (bd, git,
// lsof, ps, pgrep, the panel refresh), the stack's controls and update (docker
// compose, git), the backup's R2 metadata snapshots (sqlite3) and the signal
// lanes. So "when is a command finished?" has one answer: once its
// output has ended, not merely once it exited.
//
// Node can emit a child's 'exit' while its output is still in the pipe (the
// child_process docs: "the child process stdio streams might still be open").
// A helper that resolved on 'exit' could hand back exit 0 with a truncated or
// empty stdout on a busy machine. 'close' fires once the process has exited
// and both streams have ended.
//
// The timeout still bounds the whole wait. A command can leave a process of its
// own holding the pipe (git's ssh, a shell's background job), and 'close' waits
// for that one too, so when time runs out the command is killed and the pipes
// are closed from this end.

import { spawn } from 'node:child_process';
import os from 'node:os';

/** The code a timed-out command reports, as GNU `timeout` does. */
export const TIMED_OUT_CODE = 124;

/** 128 + the signal's number, the shell's convention: a command a signal
 * ended never reads as a plain 1, the answer "no" from git merge-base, lsof
 * and pgrep. */
function exitCode(code, signal) {
  if (code !== null) return code;
  const number = signal ? os.constants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

/**
 * Run one command; never rejects. Resolves `{ code, stdout, stderr, timedOut,
 * error }`:
 *
 *   code      the exit code; TIMED_OUT_CODE when the timeout ended the wait,
 *             128 + the signal's number when a signal ended the command, 127
 *             when it could not be started
 *   timedOut  true when `timeoutMs` passed first
 *   error     the spawn error when it could not be started, else null
 *
 * Options: `cwd`; `env` (default: this process's); `timeoutMs` (default 30 s,
 * `Infinity` for none); `stdin` (optional string or Buffer, sent exactly and
 * closed); `inherit` (the command uses this terminal and nothing
 * is collected); `onOutput(text)` (each piece of either stream as it arrives,
 * as well as collected).
 */
export function runCommand(
  command,
  args,
  { cwd, env = process.env, timeoutMs = 30_000, inherit = false, onOutput = null, stdin = null } = {},
) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      if (stdin !== null && ((!Buffer.isBuffer(stdin) && typeof stdin !== 'string') || inherit)) {
        throw new TypeError('Command stdin requires a string or Buffer and collected output.');
      }
      child = spawn(command, args, { cwd, env, stdio: inherit ? 'inherit' : [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (error) {
      settle({ code: 127, stdout, stderr: error.message, timedOut, error });
      return;
    }

    if (stdin !== null) {
      // An early-exiting child can close its input pipe before consuming it.
      // Its actual exit status and output remain the command's result.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }

    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      }, timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      onOutput?.(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      onOutput?.(chunk);
    });
    child.on('error', (error) => {
      settle({ code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut, error });
    });
    child.on('close', (code, signal) => {
      settle({ code: timedOut ? TIMED_OUT_CODE : exitCode(code, signal), stdout, stderr, timedOut, error: null });
    });
  });
}
