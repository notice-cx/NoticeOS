// Read-only UI probes reuse the journeys' installed browser, never a user profile.
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { JOURNEY_BROWSERS } from '../apps/tower/e2e/journey-browsers.mjs';

const runFile = promisify(execFile);
const requireTower = createRequire(new URL('../apps/tower/package.json', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function installedBrowser(cache) {
  const entry = requireTower.resolve('@playwright/test');
  const { stdout } = await runFile(process.execPath,
    ['-e', 'process.stdout.write(require(process.argv[1]).chromium.executablePath())', entry],
    { env: { PLAYWRIGHT_BROWSERS_PATH: cache, ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) }, timeout: 10_000, maxBuffer: 16_384 });
  return stdout;
}

/** Lookup only: downloading is the separate journey:install command. */
export async function resolveAuditBrowser(override, { lookup = installedBrowser, cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? JOURNEY_BROWSERS } = {}) {
  if (override) return override;
  try {
    if (!path.isAbsolute(cache)) throw new Error();
    const binary = await lookup(cache);
    const relative = path.relative(cache, binary);
    if (!path.isAbsolute(binary) || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error();
    await fs.access(binary, constants.X_OK);
    return binary;
  } catch {
    throw new Error('The testing browser is missing. Run pnpm --filter @noticeos/tower journey:install once, or provide --chrome PATH.');
  }
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** A profile is removed only after this recorded browser group has retired. */
export async function launchAuditBrowser(binary, viewport, { signal, launchMs = 15_000, stopMs = 3_000 } = {}) {
  signal?.throwIfAborted();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-audit-browser-'));
  let child, ended = false, launchError, stderr = '', cleanup;
  const kill = () => cleanup ??= (async () => {
    if (child?.pid) {
      const deadline = Date.now() + stopMs;
      if (groupExists(child.pid)) signalGroup(child.pid, 'SIGTERM');
      let escalated = false;
      while (!ended || groupExists(child.pid)) {
        if (Date.now() >= deadline) throw new Error(`The audit browser did not retire; its profile was retained at ${profile}.`);
        if (!escalated && Date.now() >= deadline - stopMs / 2 && groupExists(child.pid)) {
          signalGroup(child.pid, 'SIGKILL'); escalated = true;
        }
        await wait(20);
      }
    }
    await fs.rm(profile, { recursive: true, force: true });
  })();
  try {
    child = spawn(binary, ['--headless=new', `--window-size=${viewport.width},${viewport.height}`,
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--hide-scrollbars', '--disable-crash-reporter', 'about:blank'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', error => { launchError = error; });
    child.once('close', () => { ended = true; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384); });
    const deadline = Date.now() + launchMs;
    while (Date.now() < deadline && !ended && !launchError) {
      signal?.throwIfAborted();
      try {
        const port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65_535) return { port, kill, profile, pid: child.pid };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await wait(20);
    }
    signal?.throwIfAborted();
    throw new Error(`Chrome never opened a DevTools port (${binary}).\n${launchError?.message ?? stderr.trim()}`);
  } catch (error) { await kill(); throw error; }
}

/** Signals interrupt the probe and drain only its browser before returning. */
export async function withAuditBrowser(binary, viewport, read, { launch = launchAuditBrowser, attach, signals = process } = {}) {
  const abort = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => {
    process.exitCode = name === 'SIGINT' ? 130 : 143;
    abort.abort(new Error(`The audit was interrupted by ${name}.`));
  }]));
  for (const [name, handler] of handlers) signals.on(name, handler);
  let probe, page;
  const interrupted = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
  interrupted.catch(() => {}); // Startup can reject before the race is attached.
  // Startup observes the same abort; attach/read is raced so a stalled caller cannot hold cleanup.
  try {
    probe = await launch(binary, viewport, { signal: abort.signal });
    const action = (async () => {
      page = await attach(probe.port);
      if (abort.signal.aborted) page.close();
      abort.signal.throwIfAborted();
      return read(page);
    })();
    return await Promise.race([action, interrupted]);
  } finally {
    try { page?.close(); }
    finally {
      try { if (probe) await probe.kill(); }
      finally { for (const [name, handler] of handlers) signals.off(name, handler); }
    }
  }
}
