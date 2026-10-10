// POST /api/beads-snapshot — the task-hub photograph writer. Operator-authed;
// the body is handed to the writer, which validates every field. The caller is
// the runner's poller, the only thing on the machine that can reach the hub.
// No idempotent re-post: two snapshots a second apart are two observations of
// a changing hub, so every POST appends a row and the write prunes the tail.

import { authenticateOperator } from '../auth.js';
import { type BeadsSnapshotInput, writeBeadsSnapshot } from '../beads-snapshots.js';
import { json } from '../responses.js';
import { readJsonObject } from './validate.js';

export async function handleBeadsSnapshot(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

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
