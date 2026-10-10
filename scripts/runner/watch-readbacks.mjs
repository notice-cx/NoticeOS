// runner/watch-readbacks.mjs — carries each closed bet's verdict to the bead
// that owns its reading: the store keeps the queue, this lane posts
// a `bd comment` in the owning project, then tells the store what landed.

import path from 'node:path';
import { readTaskProjectConfig } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT } from './config.mjs';
import { log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';
import { beadsFailure, parseBeadsProjects, runBd } from './task-hub.mjs';

/** The readback queue's door (workers/ingest/src/routes/watch-readbacks.ts). */
export function watchReadbacksUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/watch-readbacks`;
}

/**
 * Carry each closed bet's verdict to the bead that owns its reading.
 *
 * This lane exists because neither end can do it alone. The evaluator lives in
 * a Worker and cannot run `bd`; the beads hub knows nothing about watch
 * windows. So the store keeps the queue, this process does the posting, and the
 * store is told what actually landed — in that order, so a crash mid-post
 * leaves a verdict pending rather than silently delivered.
 *
 * Silent when nothing is owed. A lane that logged "0 verdicts" every hour would
 * be teaching the operator to skim the one line that matters.
 */
export async function runWatchReadbackFiler(deps = {}) {
  const {
    config = CONFIG,
    readToken = operatorToken,
    fetchImpl = fetch,
    run = runBd,
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    emit = log,
    repoRoot = HOME_ROOT,
  } = deps;

  const token = await readToken();
  if (!token) {
    emit('WARN', 'watch readbacks skipped — no operator token');
    return { posted: [], failed: [] };
  }

  const url = watchReadbacksUrl(config);
  const auth = { authorization: `Bearer ${token}` };
  let pending;
  try {
    const res = await fetchImpl(url, { headers: auth });
    if (!res.ok) {
      emit('WARN', `watch readbacks: the door answered HTTP ${res.status}`);
      return { posted: [], failed: [] };
    }
    ({ pending } = await res.json());
  } catch (err) {
    emit('WARN', `watch readbacks: ${err.message}`);
    return { posted: [], failed: [] };
  }
  if (!Array.isArray(pending) || pending.length === 0) return { posted: [], failed: [] };

  let projects = [];
  try {
    projects = parseBeadsProjects(await readConfig());
  } catch (err) {
    const failure = `task configuration unavailable: ${err.message}`;
    emit('WARN', `watch readbacks skipped — ${failure}`);
    return { posted: [], failed: pending.map((entry) => `${entry.bead}: ${failure}`) };
  }
  const spokes = new Map(projects.map((project) => [project.asset, project]));

  const posted = [];
  const failed = [];
  for (const entry of pending) {
    const spoke = spokes.get(entry.asset);
    if (!spoke) {
      failed.push(`${entry.bead}: no beads spoke is configured for ${entry.asset}`);
      continue;
    }
    if (spoke.unavailableReason) {
      failed.push(`${entry.bead}: ${spoke.unavailableReason}`);
      continue;
    }
    // `-C <repo>`: bead ids are project-scoped, and the hub answers for the
    // project whose repo it is asked from. Resolved from the home checkout:
    // the inventory's paths are relative to it, not to a runtime copy.
    let result;
    try {
      result = await run(['-C', path.resolve(repoRoot, spoke.repo), 'comment', entry.bead, entry.comment]);
    } catch (err) {
      failed.push(`${entry.bead}: bd comment spawn error: ${err.message}`);
      continue;
    }
    if (result.code !== 0) {
      failed.push(beadsFailure('comment', result));
      continue;
    }
    posted.push(entry.windowId);
  }

  if (posted.length > 0) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ posted }),
      });
      if (!res.ok) {
        // The comments ARE on the beads; only the stamp failed. Saying so is
        // what stops the next tick's duplicate from looking like a mystery.
        emit(
          'WARN',
          `watch readbacks: ${posted.length} verdict(s) filed but NOT stamped (HTTP ${res.status}) — ` +
            'the next tick will file them again',
        );
      }
    } catch (err) {
      emit('WARN', `watch readbacks: filed but not stamped — ${err.message}`);
    }
  }

  const filed = pending
    .filter((entry) => posted.includes(entry.windowId))
    .map((entry) => `${entry.bead} ${entry.outcome}`)
    .join(' · ');
  if (posted.length > 0) {
    emit('INFO', `watch readbacks — ${posted.length} verdict(s) filed: ${filed}`);
  }
  for (const failure of failed) emit('WARN', `watch readbacks: ${failure}`);
  return { posted, failed };
}
