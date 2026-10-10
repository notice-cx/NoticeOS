// POST /api/signal-collect: collect one property's DataForSEO or PostHog
// families now. Not a second collector: the body becomes a scope and the same
// function the cron calls does the work, so the manifest row, archive and
// recorded cost are what the scheduled lane would have written. Before any
// money is spent the property is matched against the collector's own
// membership query and each named family against its own family list and
// config; asking for a panel the property is not configured for is a 422, never
// a $0.00 success. One run at a time: the collector's refusal becomes a 409
// naming the run in flight, and PostHog's per-asset lease the same.

import {
  DATAFORSEO_REPORTS,
  dataForSeoCandidates,
  dataForSeoFamiliesFor,
  runDataForSeoDumps,
  type DataForSeoDumpsOptions,
  type DataForSeoRunInFlight,
  type SerpPanelConfig,
} from '../dataforseo-dumps.js';
import { authenticateOperator } from '../auth.js';
import {
  POSTHOG_MAX_EXPLICIT_WINDOW_DAYS,
  posthogCandidates,
  runPosthogDumps,
  type PosthogDumpsOptions,
  type PosthogWindow,
} from '../posthog-dumps.js';
import { readCollectorConfigs } from '../config-store.js';
import { type LaneRegister, laneDeclined } from '../lane-mapping.js';
import { json } from '../responses.js';
import { Issues, SITE_ROW_FIELDS, asObject, declaredString, isoDate } from './validate.js';
import {
  POSTHOG_FAMILIES,
  posthogFamilyFromTag,
  posthogFamilyTag,
  type PosthogFamily,
} from '@noticeos/contract';

/** The collectors' own options, so a test drives the real runners with a
 * mocked provider. */
export interface SignalCollectOptions extends DataForSeoDumpsOptions {
  posthog?: PosthogDumpsOptions;
}

export async function handleSignalCollect(
  request: Request,
  env: IngestEnv,
  // The scope is set below and cannot be supplied from here: what a request may
  // narrow is decided by this route.
  options: SignalCollectOptions = {},
): Promise<Response> {
  const { posthog: posthogOptions, ...dataForSeoOptions } = options;
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

  // PostHog families are named `posthog-<family>` (or `posthog-*`) and go to
  // the PostHog collector; everything else is DataForSEO's. One request, one
  // provider.
  if (Array.isArray(body.families) && body.families.some(isPosthogTag)) {
    return handlePosthogCollect(env, body, posthogOptions ?? {});
  }

  const issues = new Issues();
  const asset = declaredString(issues, body.asset, 'asset', SITE_ROW_FIELDS.id);
  const families = validFamilies(issues, body.families);
  if (body.start !== undefined || body.end !== undefined) {
    issues.add('start', 'custom', 'start and end apply to PostHog families only (posthog-*)');
  }

  if (!issues.ok || asset === null) {
    return json({ error: 'validation', issues: issues.list }, 422);
  }

  // The collector's membership rule, asked about one property: one this comes
  // back empty for would write nothing and bill nothing while reading as a
  // success.
  const [candidate] = await dataForSeoCandidates(env.STORE, asset);
  if (!candidate) {
    return json(
      { error: 'unknown_asset', detail: await whyNotCollected(env, asset, 'DataForSEO') },
      422,
    );
  }

  // The register and the tracked panel the cron would read on this fire,
  // store-first, so a property declined on its Data sources row is refused
  // here by name; the run below reads the same documents.
  const configs =
    dataForSeoOptions.laneRegister === undefined || dataForSeoOptions.serpPanelConfig === undefined
      ? await readCollectorConfigs(env, ['config/integrations.json', 'config/serp-panel.json'])
      : null;
  const laneRegister =
    dataForSeoOptions.laneRegister ??
    (configs?.documents['config/integrations.json'] as LaneRegister | undefined);
  const serpPanelConfig =
    dataForSeoOptions.serpPanelConfig ??
    (configs?.documents['config/serp-panel.json'] as SerpPanelConfig | undefined);
  if (laneDeclined(asset, 'dataforseo', laneRegister)) return declinedRefusal(asset, 'DataForSEO');

  // Every family the property is due: the set an unscoped run would collect.
  const due = dataForSeoFamiliesFor(asset, serpPanelConfig);
  const missing = (families ?? []).filter((family) => !due.includes(family));
  if (missing.length > 0) {
    return json(
      {
        error: 'family_unavailable',
        detail:
          `${asset} has no ${missing.join(', ')} to collect. ` +
          'The tracked SERP panel is the one DataForSEO family a property must be ' +
          'named in config/serp-panel.json to receive; add it there first. ' +
          `Available for ${asset}: ${due.join(', ')}.`,
        asset,
        families: missing,
        available: due,
      },
      422,
    );
  }

  const collected = families ?? due;
  const result = await runDataForSeoDumps(env, {
    ...dataForSeoOptions,
    laneRegister,
    serpPanelConfig,
    configSources: dataForSeoOptions.configSources ?? configs?.sources,
    scope: { asset, families: collected },
  });

  // Another collection already held the lane, so this request asked for
  // nothing and wrote nothing. A 409 rather than a queue slot: the run the
  // operator cannot see is the reason they fired again, and a queue would bill
  // them twice.
  if (result.refused) {
    return json(
      {
        error: 'collection_in_flight',
        detail: inFlightDetail(result.refused),
        inFlight: result.refused,
        asset,
        families: collected,
      },
      409,
    );
  }

  // 200, not 201: this reports a run, the same whether every family landed,
  // one was unchanged, or the cap gate refused them all. A failure is an
  // outcome with a price; `pnpm signals:collect` exits non-zero on any of them.
  return json(
    {
      collected: true,
      asset,
      families: collected,
      attempted: result.attempted,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      // The same six decimals the completion log rounds to.
      costUsd: Number(result.costUsd.toFixed(6)),
      retried: result.outcomes
        .filter((outcome) => outcome.retries > 0)
        .map(({ report, status, retries }) => ({ report, status, retries })),
      outcomes: result.outcomes.map((outcome) => ({
        report: outcome.report,
        reportDate: outcome.reportDate,
        status: outcome.status,
        providerRows: outcome.providerRows,
        objectKey: outcome.objectKey,
        costUsd: Number(outcome.costUsd.toFixed(6)),
        retries: outcome.retries,
        errorCode: outcome.errorCode,
      })),
    },
    200,
  );
}

/**
 * The refusal in one sentence. `pnpm signals:collect` surfaces the first 400
 * characters of this body, so it leads with what is running and says this
 * call cost nothing. The lease expiry is here because a run whose client hung
 * up may never return.
 */
function inFlightDetail(inFlight: DataForSeoRunInFlight): string {
  const { scope } = inFlight;
  const what = scope
    ? `${scope.asset}${scope.families ? ` (${scope.families.join(', ')})` : ''}`
    : 'the weekly portfolio sweep';
  return (
    `A DataForSEO collection is already running — ${what}, started ${inFlight.startedAt}, ` +
    `${inFlight.runningSeconds}s ago. Nothing was billed for this call: two runs at once pay ` +
    'for the same families twice. Wait for its dataforseo_dumps_complete line in os-up.log, ' +
    `or fire again after ${inFlight.leaseExpiresAt} if that run died.`
  );
}

/**
 * A requested subset of the collector's families, or null for everything this
 * property is due. Checked against `DATAFORSEO_REPORTS`, the collector's own
 * list, so this route cannot accept a family the sweep no longer has. A repeat
 * is rejected rather than deduplicated: quietly billing once for it would hide
 * the caller's bug.
 */
function validFamilies(issues: Issues, value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    issues.add(
      'families',
      'invalid_type',
      `families must be a non-empty array of report families: ${DATAFORSEO_REPORTS.join(', ')}`,
    );
    return null;
  }
  const families: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !DATAFORSEO_REPORTS.includes(entry)) {
      issues.add(
        'families',
        'invalid_value',
        `families entries must be one of: ${DATAFORSEO_REPORTS.join(', ')}`,
      );
      return null;
    }
    if (families.includes(entry)) {
      issues.add('families', 'custom', `families must not repeat a family (${entry})`);
      return null;
    }
    families.push(entry);
  }
  return families;
}

/** A named collection of a source its Data sources row declines: refused by
 * name, before anything is requested or billed. */
function declinedRefusal(asset: string, provider: string): Response {
  return json(
    {
      error: 'declined',
      detail: `${asset} is marked Not using for ${provider} on its Data sources tab; nothing was requested or billed.`,
      asset,
    },
    422,
  );
}

async function whyNotCollected(env: IngestEnv, asset: string, provider: string): Promise<string> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ status: string; isOs: boolean; domain: string | null }>(
      `SELECT status, is_os AS "isOs", domain FROM noticeos.assets WHERE asset_id = $1`,
      [asset],
    ),
  );
  if (!row) return `${asset} is not a property in the store.`;
  if (row.isOs) return `${asset} is the OS itself and has no public search surface.`;
  if (row.status === 'pre-launch' || row.status === 'retired') {
    return provider === 'DataForSEO'
      ? `${asset} is ${row.status}; the DataForSEO lane collects launched properties only.`
      : `${asset} is ${row.status}; the ${provider} collector reads launched properties only.`;
  }
  return `${asset} has no canonical domain, so there is nothing to ask the provider about.`;
}

// ---------------------------------------------------------------------------
// PostHog on demand
// ---------------------------------------------------------------------------

function isPosthogTag(value: unknown): boolean {
  return typeof value === 'string' && (value === 'posthog' || value.startsWith('posthog-'));
}

/**
 * Collect one asset's PostHog families now, through the same collector the
 * cron runs. `start`/`end` pin one window for every family, so a past reading
 * can be reproduced. PostHog bills nothing per query; its hourly allowance
 * still applies.
 */
async function handlePosthogCollect(
  env: IngestEnv,
  body: Record<string, unknown>,
  options: PosthogDumpsOptions,
): Promise<Response> {
  const issues = new Issues();
  const asset = declaredString(issues, body.asset, 'asset', SITE_ROW_FIELDS.id);
  const families = validPosthogFamilies(issues, body.families);
  const window = validWindow(issues, body.start, body.end);
  if (!issues.ok || asset === null || families === null) {
    return json({ error: 'validation', issues: issues.list }, 422);
  }
  const candidates = await posthogCandidates(env.STORE);
  if (!candidates.some((candidate) => candidate.asset === asset)) {
    return json({ error: 'unknown_asset', detail: await whyNotCollected(env, asset, 'PostHog') }, 422);
  }
  // The register the cron would read on this fire, store-first.
  const configs =
    options.laneRegister === undefined
      ? await readCollectorConfigs(env, ['config/integrations.json'])
      : null;
  const laneRegister =
    options.laneRegister ??
    (configs?.documents['config/integrations.json'] as LaneRegister | undefined);
  if (laneDeclined(asset, 'posthog', laneRegister)) return declinedRefusal(asset, 'PostHog');
  const result = await runPosthogDumps(env, {
    ...options,
    laneRegister,
    configSources: options.configSources ?? configs?.sources,
    scope: { asset, families, ...(window ? { window } : {}) },
  });
  const tags = families.map(posthogFamilyTag);
  // Another run holds this asset: nothing was asked of PostHog. A 409, not a
  // queue slot, which would spend the allowance the refusal protects.
  const inFlight = result.skipped.find((skip) => skip.reason === 'in-flight');
  if (result.attempted === 0 && inFlight) {
    return json(
      { error: 'collection_in_flight', detail: inFlight.detail, inFlight: inFlight.inFlight, asset, families: tags },
      409,
    );
  }
  // The whole asset was skipped before any request: a refusal the CLI exits
  // non-zero on, rather than a 200 that collected nothing.
  const assetSkip = result.skipped.find((skip) => skip.family === null);
  if (result.attempted === 0 && assetSkip) {
    return json(
      { error: 'posthog_not_collected', reason: assetSkip.reason, detail: assetSkip.detail, asset, families: tags },
      422,
    );
  }
  // The earlier windows this run asked again, window by window; each reads as
  // `retries: 1` in the shape DataForSEO's retries use.
  const recollected = new Set(result.recollected);
  return json(
    {
      collected: true,
      asset,
      families: tags,
      window: window ?? null,
      attempted: result.attempted,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      // PostHog charges nothing per query; one summary format serves both providers.
      costUsd: 0,
      retried: result.recollected.map((outcome) => ({
        report: posthogFamilyTag(outcome.report as PosthogFamily),
        reportDate: outcome.reportDate,
        status: outcome.status,
        retries: 1,
        errorCode: outcome.errorCode,
      })),
      // Owed earlier windows left for the next run, as the daily line says.
      retryNotAsked: result.retryNotAsked,
      budgetStopped: result.budgetStopped,
      budgetRemainingBytes: result.budgetRemainingBytes,
      skipped: result.skipped.map(({ family, reason, detail }) => ({
        report: family === null ? null : posthogFamilyTag(family),
        reason,
        detail,
      })),
      outcomes: result.outcomes.map((outcome) => ({
        report: posthogFamilyTag(outcome.report as PosthogFamily),
        reportDate: outcome.reportDate,
        status: outcome.status,
        providerRows: outcome.providerRows,
        objectKey: outcome.objectKey,
        costUsd: 0,
        retries: recollected.has(outcome) ? 1 : 0,
        errorCode: outcome.errorCode,
      })),
    },
    200,
  );
}

/** `posthog-*` (or `posthog`) is every family; otherwise each `posthog-<family>`
 * named once. Mixing in a DataForSEO family is refused: one request, one
 * provider. */
function validPosthogFamilies(issues: Issues, value: unknown): PosthogFamily[] | null {
  const entries = Array.isArray(value) ? value : [];
  const tags = entries.filter((entry): entry is string => typeof entry === 'string');
  if (tags.length !== entries.length || tags.some((tag) => !isPosthogTag(tag))) {
    issues.add(
      'families',
      'invalid_value',
      'families must all be PostHog families (posthog-*) or all DataForSEO families — one provider per request',
    );
    return null;
  }
  if (tags.some((tag) => tag === 'posthog' || tag === 'posthog-*')) {
    if (tags.length > 1) {
      issues.add('families', 'custom', 'posthog-* already names every PostHog family; name it alone');
      return null;
    }
    return [...POSTHOG_FAMILIES];
  }
  const families: PosthogFamily[] = [];
  for (const tag of tags) {
    const family = posthogFamilyFromTag(tag);
    if (family === null) {
      issues.add(
        'families',
        'invalid_value',
        `families entries must be posthog-* or one of: ${POSTHOG_FAMILIES.map(posthogFamilyTag).join(', ')}`,
      );
      return null;
    }
    if (families.includes(family)) {
      issues.add('families', 'custom', `families must not repeat a family (${tag})`);
      return null;
    }
    families.push(family);
  }
  return families;
}

/** An explicit inclusive window: both ends or neither, at most the web-daily
 * bound long, and never ending after today (UTC). */
function validWindow(issues: Issues, start: unknown, end: unknown): PosthogWindow | null {
  if (start === undefined && end === undefined) return null;
  if (start === undefined || end === undefined) {
    issues.add(start === undefined ? 'start' : 'end', 'custom', 'start and end must be given together');
    return null;
  }
  const from = isoDate(issues, start, 'start');
  const to = isoDate(issues, end, 'end');
  if (from === null || to === null) return null;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days < 1) {
    issues.add('start', 'custom', 'start must not be after end');
    return null;
  }
  if (days > POSTHOG_MAX_EXPLICIT_WINDOW_DAYS) {
    issues.add('end', 'custom', `a window may be at most ${POSTHOG_MAX_EXPLICIT_WINDOW_DAYS} days`);
    return null;
  }
  if (to > new Date().toISOString().slice(0, 10)) {
    issues.add('end', 'custom', 'end must not be in the future');
    return null;
  }
  return { start: from, end: to };
}
