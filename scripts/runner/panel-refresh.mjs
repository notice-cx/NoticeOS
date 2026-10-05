// runner/panel-refresh.mjs — the daily lane that rebuilds every rostered
// property's local signal panels by running `pnpm signals:refresh` as a child
// (through scripts/run-command.mjs), so the flatten never stalls the runner.

import { runCommand } from '../run-command.mjs';
import { REPO_ROOT } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { log, writeLine } from './log.mjs';
import { beadsSkipDecision } from './task-hub.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Panel refresh — the lane that keeps `.local/signal-dumps/reports/<asset>/`
// current for every rostered property (config/signal-panels.json), so a property
// repo's agent reads panels instead of re-pulling providers
// (docs/20-signal-panels.md).
//
// Historically, before the 2026-08 panel refresh, collection was on a cron
// and FLATTENING was not: the archives
// landed nightly in R2 and the panel dir held whatever an operator last ran
// `pnpm signals:download && pnpm signals:analyze` for. One property's panel was
// a single 2026-07-30 pull, and it was still the freshest thing it had.
//
// A SPAWNED CHILD, not an in-process call. The flatten runs the whole insights
// rules engine over a pinned history generation, per property — synchronous
// CPU each. Doing that inside the supervisor would stall the beads poller
// (`* * * * *`) and every cron fire behind it, so the work goes to a child and
// this process only reads its exit code.
//
// It costs no provider money: the refresh reads archives the `15 12 * * *` and
// `45 12 * * 1` collectors already bought, through the ingest's own
// operator-authed read routes. See scripts/signal-panels-refresh.mjs.
// ─────────────────────────────────────────────────────────────────────────────

/** How long one full-portfolio refresh may take before it is killed. Generous:
 * a first pass on a property with no local archives downloads a whole window. */
const PANEL_REFRESH_TIMEOUT_MS = 15 * 60_000;

const panelRefreshState = { skipping: null, running: false };

/**
 * One refresh pass.
 *
 * Skipped while the runtime is down — every read goes through the ingest door,
 * so a pass with no runtime would only produce failures — and skipped while a
 * previous pass is still running, because two children writing one panel dir is
 * how a half-written CSV gets read as provider data.
 */
export async function runPanelRefresh(runtime, deps = {}) {
  const {
    run = runCommand,
    state = panelRefreshState,
    emit = log,
    stopped = () => isShuttingDown(),
  } = deps;

  const skip = (reason) => {
    if (beadsSkipDecision(state, reason)) {
      emit('WARN', `panel refresh skipped — ${reason} (silent until it changes)`);
    }
  };

  if (stopped()) return null;
  if (!runtime.running || !runtime.ready) {
    skip('ingest is down/restarting');
    return null;
  }
  if (state.running) {
    skip('the previous pass has not finished');
    return null;
  }
  if (state.skipping !== null) {
    emit('INFO', `panel refresh resumed (was skipped: ${state.skipping})`);
    state.skipping = null;
  }

  state.running = true;
  const startedAt = Date.now();
  let result;
  try {
    result = await run('pnpm', ['signals:refresh'], {
      cwd: REPO_ROOT,
      timeoutMs: PANEL_REFRESH_TIMEOUT_MS,
      onOutput: (text) => {
        for (const line of text.split('\n')) {
          if (line.trim() !== '') writeLine('[panels]', line.trimEnd());
        }
      },
    });
  } finally {
    state.running = false;
  }
  if (result.error) {
    emit('ERROR', `panel refresh could not run: ${result.error.message}`);
    return { code: 1, seconds: 0 };
  }
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (result.code === 0) {
    emit('INFO', `panel refresh finished in ${seconds}s`);
  } else {
    emit('ERROR', `panel refresh exited ${result.code} after ${seconds}s`);
  }
  return { code: result.code, seconds };
}
