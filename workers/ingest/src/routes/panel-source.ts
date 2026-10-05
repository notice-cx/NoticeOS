// GET /api/panel-source    — what the standing panel refresh needs from D1.
// GET /api/signal-archives — the same manifest, filtered the way an operator
//                            asks for it by hand (`pnpm signals:download`).
// GET /api/panel-object    — one archived provider response, decompressed.
//
// Operator-authed and READ-ONLY. The callers are `scripts/signal-panels-refresh.mjs`
// and `scripts/signal-dumps-download.mjs` in the local runner, neither of which
// can reach D1 or R2 without starting a second workerd over the store (see
// ../panel-source.ts for why that is the thing being avoided). These three are
// the seam: the Worker owns the store, the scripts own the filesystem, and
// nothing under scripts/ opens the sqlite file twice.

import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import {
  ASSET_ID_RE,
  ISO_DATE_RE,
  type PanelManifestFilters,
  SLUG_RE,
  panelSourceWindowDays,
  readPanelManifest,
  readPanelObject,
  readPanelSource,
} from '../panel-source.js';

export async function handlePanelSource(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  const asset = (url.searchParams.get('asset') ?? '').trim();
  if (asset === '' || !ASSET_ID_RE.test(asset)) {
    return json({ error: 'asset_required' }, 400);
  }
  const windowDays = panelSourceWindowDays(url.searchParams.get('windowDays'));
  return json(await readPanelSource(env, asset, windowDays, nowMs), 200);
}

/** One optional filter, trimmed. Absent and empty mean the same thing here:
 * a caller that typed no `--integration` and one that typed an empty one are
 * both asking for every integration. */
function filterParam(url: URL, name: string): string | null {
  const raw = (url.searchParams.get(name) ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * The archive manifest, filtered — the read behind `pnpm signals:download`.
 *
 * Separate from `/api/panel-source` because the two questions differ in the one
 * way that matters. The refresh asks "what landed inside my window?" and gets
 * the trend series with it; an operator asks "give me GSC for July", names an
 * explicit range or none at all, and never wants the daily series. Folding both
 * into one route would mean either a window imposed on the hand lane — silently
 * dropping the history it asked for — or a trend query computed over the whole
 * archive for a caller that discards it.
 *
 * A malformed filter is a 400 rather than a filter quietly ignored: an operator
 * who mistyped `--from` must not be handed a wider answer than they asked for
 * and left to notice.
 */
export async function handleSignalArchives(
  request: Request,
  env: IngestEnv,
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  const asset = (url.searchParams.get('asset') ?? '').trim();
  if (asset === '' || !ASSET_ID_RE.test(asset)) {
    return json({ error: 'asset_required' }, 400);
  }

  const filters: PanelManifestFilters = {
    from: filterParam(url, 'from'),
    to: filterParam(url, 'to'),
    integration: filterParam(url, 'integration'),
    report: filterParam(url, 'report'),
  };
  for (const [name, pattern, expected] of [
    ['from', ISO_DATE_RE, 'a YYYY-MM-DD date'],
    ['to', ISO_DATE_RE, 'a YYYY-MM-DD date'],
    ['integration', SLUG_RE, 'lowercase letters, numbers and hyphens'],
    ['report', SLUG_RE, 'lowercase letters, numbers and hyphens'],
  ] as const) {
    const value = filters[name];
    if (value !== null && value !== undefined && !pattern.test(value)) {
      return json({ error: 'invalid_filter', detail: `${name} must be ${expected}` }, 400);
    }
  }

  return json(
    { asset, filters, manifest: await readPanelManifest(env, asset, filters) },
    200,
  );
}

export async function handlePanelObject(
  request: Request,
  env: IngestEnv,
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);
  const key = (url.searchParams.get('key') ?? '').trim();
  if (key === '') {
    return json({ error: 'key_required' }, 400);
  }
  const body = await readPanelObject(env, key);
  if (body === null) {
    return json({ error: 'unknown_object' }, 404);
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
