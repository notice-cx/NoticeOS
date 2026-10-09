// POST /api/reclamation-targets — a campaign's target list, from
// `pnpm reclamation:import` (bead ro-ujb9.76.5.8). Operator-authed, the same
// shape as /api/annotations: a script on this machine writes the store through
// the ingest's door, never with a database credential of its own.
//
// Body: { asset, targets: [{ tier, segment, domain, referringPage,
// linksToDead, replaceWith, contact, notes, status, statusAt, lastVerifiedAt,
// outcomeNote }] }. A date-only `statusAt` or `lastVerifiedAt` is 00:00 UTC
// that day.
//
// GET /api/reclamation-targets?asset=<site>&open=1 — the site's open targets,
// for `pnpm reclamation:open-targets` (bead ro-ujb9.76.5.9), which writes the
// file the reclamation-match rule reads. Operator-authed through the same
// door. Answers { ok, asset, targets: [{ domain, referringPage, replaceWith,
// status }] }, in the order they were stored.

import { assetKnown } from '../asset-registry.js';
import { authenticateOperator } from '../auth.js';
import {
  RECLAMATION_STATUSES,
  type ReclamationTargetInput,
  importReclamationTargets,
  readOpenReclamationTargets,
} from '../reclamation-targets.js';
import { json } from '../responses.js';
import { Issues, asObject, enumValue, optionalString, requiredString } from './validate.js';

/** Enough for any campaign; a bound, not a quota. */
export const RECLAMATION_TARGETS_MAX = 5_000;
/** Evidence text a research pass records: long, never unbounded. */
const TEXT_MAX = 10_000;
/** The table's own bound on a domain. */
const DOMAIN_MAX = 253;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An instant, a 'YYYY-MM-DD' day (00:00 UTC), or null; ISO-8601 UTC out. */
function optionalInstant(issues: Issues, value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? (DAY.test(value) ? `${value}T00:00:00.000Z` : value) : null;
  const ms = text === null ? Number.NaN : Date.parse(text);
  if (!Number.isFinite(ms)) {
    issues.add(path, 'invalid_format', `${path} must be a YYYY-MM-DD date or an ISO-8601 datetime`);
    return null;
  }
  return new Date(ms).toISOString();
}

function target(issues: Issues, value: unknown, path: string): ReclamationTargetInput | null {
  const body = asObject(value);
  if (!body) {
    issues.add(path, 'invalid_type', `${path} must be an object`);
    return null;
  }
  const before = issues.list.length;
  let tier: number | null = null;
  if (body.tier !== undefined && body.tier !== null) {
    if (typeof body.tier === 'number' && Number.isInteger(body.tier) && body.tier >= 1 && body.tier <= 2_147_483_647) tier = body.tier;
    else issues.add(`${path}.tier`, 'invalid_value', `${path}.tier must be a whole number from 1`);
  }
  let referringPage = '';
  if (typeof body.referringPage !== 'string' || body.referringPage.length > TEXT_MAX) {
    issues.add(`${path}.referringPage`, 'invalid_type', `${path}.referringPage must be a string ('' for no specific page)`);
  } else {
    referringPage = body.referringPage.trim();
  }
  const parsed: ReclamationTargetInput = {
    tier,
    segment: optionalString(issues, body.segment, `${path}.segment`, TEXT_MAX),
    domain: requiredString(issues, body.domain, `${path}.domain`, DOMAIN_MAX) ?? '',
    referringPage,
    linksToDead: optionalString(issues, body.linksToDead, `${path}.linksToDead`, TEXT_MAX),
    replaceWith: optionalString(issues, body.replaceWith, `${path}.replaceWith`, TEXT_MAX),
    contact: optionalString(issues, body.contact, `${path}.contact`, TEXT_MAX),
    notes: optionalString(issues, body.notes, `${path}.notes`, TEXT_MAX),
    status: enumValue(issues, body.status, `${path}.status`, RECLAMATION_STATUSES) ?? 'queued',
    statusAt: optionalInstant(issues, body.statusAt, `${path}.statusAt`),
    lastVerifiedAt: optionalInstant(issues, body.lastVerifiedAt, `${path}.lastVerifiedAt`),
    outcomeNote: optionalString(issues, body.outcomeNote, `${path}.outcomeNote`, TEXT_MAX),
  };
  return issues.list.length === before ? parsed : null;
}

export async function handleReclamationTargets(request: Request, env: IngestEnv): Promise<Response> {
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
  if (!body) return json({ error: 'bad_request', detail: 'body must be a JSON object' }, 400);

  const issues = new Issues();
  const asset = requiredString(issues, body.asset, 'asset', DOMAIN_MAX);
  const targets: ReclamationTargetInput[] = [];
  if (!Array.isArray(body.targets) || body.targets.length === 0 || body.targets.length > RECLAMATION_TARGETS_MAX) {
    issues.add('targets', 'invalid_type', `targets must be a list of 1 to ${RECLAMATION_TARGETS_MAX} targets`);
  } else {
    body.targets.forEach((value, index) => {
      const one = target(issues, value, `targets[${index}]`);
      if (one) targets.push(one);
    });
    const pages = new Set<string>();
    targets.forEach((one, index) => {
      const key = `${one.domain}\u0000${one.referringPage}`;
      if (pages.has(key)) issues.add(`targets[${index}]`, 'duplicate', `targets[${index}] repeats a page already in the list`);
      pages.add(key);
    });
  }
  if (!issues.ok || asset === null) return json({ error: 'validation', issues: issues.list }, 422);
  if (!(await assetKnown(env.STORE, asset))) return json({ error: 'unknown_asset', detail: asset }, 422);

  const result = await importReclamationTargets(env, asset, targets);
  return json({ ok: true, asset, ...result }, 200);
}

/**
 * A site's open targets. Bounded as a list is: a site holding more than one
 * list may carry is refused, never answered in part, because the rule reads
 * the export as every open target there is.
 */
export async function handleOpenReclamationTargets(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const params = new URL(request.url).searchParams;
  const asset = (params.get('asset') ?? '').trim();
  if (asset === '' || asset.length > DOMAIN_MAX) {
    return json({ error: 'bad_request', detail: 'asset must name a site' }, 400);
  }
  if (params.get('open') !== '1') {
    return json({ error: 'bad_request', detail: 'open=1 is required: this route answers open targets only' }, 400);
  }
  if (!(await assetKnown(env.STORE, asset))) return json({ error: 'unknown_asset', detail: asset }, 422);

  const targets = await readOpenReclamationTargets(env, asset, RECLAMATION_TARGETS_MAX + 1);
  if (targets.length > RECLAMATION_TARGETS_MAX) {
    return json({ error: 'too_many', detail: `${asset} holds more than ${RECLAMATION_TARGETS_MAX} open targets` }, 409);
  }
  return json({ ok: true, asset, targets }, 200);
}
