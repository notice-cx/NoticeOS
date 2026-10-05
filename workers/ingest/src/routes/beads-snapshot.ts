// POST /api/beads-snapshot — the task-hub photograph writer (db/0017).
//
// Operator-authed, same shape as /api/annotations: bearer → parse → hand the
// untrusted body to the writer, which validates every field before touching the
// store.
// The caller is the poller in `scripts/os-up.mjs`, which is the only thing on
// the machine that can reach the Dolt hub; this route is how what it saw
// crosses into the central store.
//
// Unlike the annotation lane there is no idempotent re-post: two snapshots a
// second apart are two different observations of a changing hub, not the same
// event recorded twice, so every POST appends a row and the write prunes the
// tail instead.

import { authenticateOperator } from '../auth.js';
import { type BeadsSnapshotInput, writeBeadsSnapshot } from '../beads-snapshots.js';
import { json } from '../responses.js';
import { asObject } from './validate.js';

export async function handleBeadsSnapshot(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch (err) {
    return json({ error: 'bad_request', detail: `could not parse body: ${String(err)}` }, 400);
  }
  const body = asObject(parsed);
  if (!body) {
    return json({ error: 'bad_request', detail: 'body must be a JSON object' }, 400);
  }

  // A claim, not a check: `writeBeadsSnapshot` validates every field of it.
  const result = await writeBeadsSnapshot(env, body as unknown as BeadsSnapshotInput, nowMs);

  if (!result.ok) {
    return json({ error: 'validation', issues: result.issues }, 422);
  }
  // Still 201 for an unchanged touch: the poller treats non-201 as failure,
  // and from its side the photograph WAS filed — dedup is the store's business.
  // No row id: a photograph has no number of its workspace's, and the store's
  // own identity never leaves it.
  return json(
    {
      created: result.unchanged !== true,
      unchanged: result.unchanged === true,
      capturedAt: result.capturedAt,
      projects: result.projects,
      pruned: result.pruned,
      historyDays: result.historyDays,
    },
    201,
  );
}
