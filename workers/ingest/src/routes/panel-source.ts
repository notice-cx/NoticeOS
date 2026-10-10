// GET /api/panel-source    — what the standing panel refresh needs from the store.
// GET /api/signal-archives — the same manifest, filtered the way an operator
//                            asks for it by hand (`pnpm signals:download`).
// GET /api/panel-object    — one archived provider response, decompressed.
//
// Operator-authed and read-only: the Worker owns the store, the local runner's
// scripts own the filesystem, and these three routes are the seam.

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
 * The archive manifest, filtered. Separate from `/api/panel-source`: the
 * refresh asks what landed inside its window and gets the trend series with
 * it; an operator names an explicit range or none, and never wants the daily
 * series. A malformed filter is a 400 rather than a filter quietly ignored, so
 * a mistyped `--from` is never handed a wider answer than asked for.
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
