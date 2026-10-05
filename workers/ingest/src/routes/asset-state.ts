// GET  /api/asset-state — what the store holds for one asset's two editable
//                         columns (the changeset `expect` guard's read).
// POST /api/asset-state — set one of them (the changeset's `store-asset-set` op).
//
// Operator-authed, both halves. The caller is `scripts/config-apply.mjs`, run by
// hand beside a live `os:up`; these two routes are how the operator's changeset
// tool reaches the central store WITHOUT a second workerd opening the sqlite file
// (../asset-state.ts has the why, bead ro-bko).
//
// The write is the sharp one: it edits a row the Tower renders as fact. It is
// bearer-gated for the same reason every other write lane is, and the column it
// will edit is matched against the two db/README sanctions before any statement
// is chosen.

import { authenticateOperator } from '../auth.js';
import { readAssetState, writeAssetColumn } from '../asset-state.js';
import { ASSET_ID_RE } from '../panel-source.js';
import { json } from '../responses.js';

export async function handleAssetState(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const asset = (new URL(request.url).searchParams.get('asset') ?? '').trim();
  if (asset === '' || !ASSET_ID_RE.test(asset)) {
    return json({ error: 'asset_required' }, 400);
  }
  // A property the store does not know answers 200 `known:false`, not 404: see
  // readAssetState — "nothing is there" is an answer to the guard's question.
  return json(await readAssetState(env, asset), 200);
}

export async function handleAssetStateEdit(
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

  // A claim, not a check: `writeAssetColumn` validates the asset, the column and
  // the value before it touches D1.
  const result = await writeAssetColumn(env, parsed, nowMs);

  if (!result.ok) {
    if (result.error === 'expect_mismatch') {
      return json({ error: 'expect_mismatch', column: result.column, current: result.current }, 409);
    }
    if (result.error === 'unknown_asset') {
      return json({ error: 'unknown_asset', detail: result.asset }, 422);
    }
    return json({ error: 'validation', issues: result.issues }, 422);
  }

  // 200, not 201: an asset row already existed and one column of it moved.
  return json(
    {
      updated: true,
      asset: result.asset,
      column: result.column,
      value: result.value,
      updatedAt: result.updatedAt,
    },
    200,
  );
}
