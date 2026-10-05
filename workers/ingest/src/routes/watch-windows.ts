// POST /api/watch-windows — register a pre-registered outcome check.
//
// Operator-authed, same shape as /api/revenue and /api/annotations. Everything
// this route validates exists so the daily evaluator (src/watch-windows.ts)
// cannot later be asked an unanswerable question: the metric must name a series
// the collectors write, the baseline must end before the change, and the final
// check must be far enough out that its post window is a clean like-for-like
// comparison. docs/03's rule is that the comparison is chosen before the
// numbers exist — a registration that cannot be evaluated is not a
// pre-registration, it is a note.
//
// TWO CAPABILITIES, ONE WRITER (bead `ro-71r`). `writeWatchWindow` below is the
// whole registration — validation and insert; this route is the operator-bearer
// door onto it, and the `createWatchWindow()` RPC on the WorkerEntrypoint is the
// Tower's (index.ts). The Tower is served unauthenticated on the LAN and must
// never hold the operator bearer, so the Service Binding is its capability —
// the same posture as `writeAnnotation`. What matters here is that the Tower's
// composer cannot reach a softer set of rules than curl does: the UI prefills,
// it does not relax, and both lanes land on the checks below.

import type {
  CreateWatchWindowInput,
  CreateWatchWindowResult,
  WatchScopeInput,
} from '@noticeos/contract';
import {
  WATCH_PAGE_MAX_CHARS,
  WATCH_QUERY_MAX_CHARS,
  WATCH_READBACK_BEAD_MAX,
} from '@noticeos/contract';
import { assetKnown } from '../asset-registry.js';
import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import { findBet, holdBet, insertWindow, type WatchBet } from '../watch-window-store.js';
import {
  WATCH_INTEGRATIONS,
  WATCH_METRICS,
  WATCH_REF_KINDS,
  daySpan,
  type WatchIntegration,
  type WatchThreshold,
  type WatchThresholds,
} from '../watch-windows.js';
import {
  asObject,
  enumValue,
  finiteNumber,
  isoDate,
  optionalString,
  pastInstant,
  requiredString,
  ASSET_ID_MAX,
  FUTURE_SKEW_MS,
  Issues,
} from './validate.js';

export const WATCH_REF_MAX = 256;
export const WATCH_NOTE_MAX = 1000;
export const WATCH_MAX_OFFSETS = 10;
/** A year out is the longest horizon docs/03's 4–8 week windows imply, with room. */
export const WATCH_MAX_OFFSET_DAYS = 365;
/** A registration is a JSON scope object at most this big; it is a selector, not a payload. */
export const WATCH_SCOPE_MAX_CHARS = 2000;

const DIRECTIONS = ['up', 'down'] as const;

export async function handleWatchWindows(
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

  const result = await writeWatchWindow(env, body as unknown as CreateWatchWindowInput, nowMs);
  if (!result.ok) {
    return result.error === 'unknown_asset'
      ? json({ error: 'unknown_asset', detail: result.asset }, 422)
      : json({ error: 'validation', issues: result.issues }, 422);
  }
  // 200 + `duplicate` on a re-registration, the same vocabulary /api/annotations
  // answers with: the caller's intent already holds, and nothing was written.
  return result.created
    ? json({ created: true, duplicate: false, watch_window: result.watchWindow }, 201)
    : json({ created: false, duplicate: true, watch_window: result.watchWindow }, 200);
}

/**
 * Validate one claimed registration and write it.
 *
 * `input` is caller-supplied on both lanes — an HTTP body and an RPC argument
 * are equally untrusted — so every field is validated here regardless of the
 * static type. A rejected field or an unknown asset comes back as a result;
 * only a store failure throws.
 */
export async function writeWatchWindow(
  env: IngestEnv,
  input: CreateWatchWindowInput,
  nowMs: number = Date.now(),
): Promise<CreateWatchWindowResult> {
  const body = input as unknown as Record<string, unknown>;
  const issues = new Issues();
  const asset = requiredString(issues, body.asset, 'asset', ASSET_ID_MAX);
  const refKind = enumValue(issues, body.ref_kind, 'ref_kind', WATCH_REF_KINDS);
  const ref = requiredString(issues, body.ref, 'ref', WATCH_REF_MAX);
  const integration = enumValue(
    issues,
    body.metric_integration,
    'metric_integration',
    WATCH_INTEGRATIONS,
  );
  const metric = validMetric(issues, body.metric, integration);
  // Backdating matters here: a batch that shipped weeks ago can still have an
  // honest watch registered against the baseline that preceded it.
  const registeredAt =
    body.registered_at === undefined || body.registered_at === null
      ? new Date(nowMs).toISOString()
      : pastInstant(issues, body.registered_at, 'registered_at', nowMs, FUTURE_SKEW_MS);
  const baselineStart = isoDate(issues, body.baseline_start, 'baseline_start');
  const baselineEnd = isoDate(issues, body.baseline_end, 'baseline_end');
  const offsets = validOffsets(issues, body.check_offsets);
  const thresholds = validThresholds(issues, body.thresholds);
  const scope = validScope(issues, body.scope, integration);
  const note = optionalString(issues, body.note, 'note', WATCH_NOTE_MAX);
  const readbackBead = optionalString(
    issues,
    body.readback_bead,
    'readback_bead',
    WATCH_READBACK_BEAD_MAX,
  );

  // Bet property-wide on sums, bet scoped on averages (ro-715c).
  //
  // A sum is scope-independent — clicks are clicks whether they landed on one
  // page or forty — so a property total answers the same question one level up.
  // An average is taken over whatever the property happened to appear for, so a
  // change that earns impressions on searches the site ranks badly for drags the
  // property average DOWN while winning. Two July deploys on one asset closed
  // `kill_confirmed` on site-wide average position while both won on clicks;
  // that is the registration this rule refuses to accept again. The refusal is
  // the field and what it needs (bead `ro-ujb9.96.6.28`): a scope of
  // {"query": "…"} or {"page": "/route"}; the composer offers an average only
  // from a query row.
  if (
    integration &&
    metric &&
    (body.scope === undefined || body.scope === null) &&
    WATCH_METRICS[integration]?.[metric] === 'mean'
  ) {
    issues.add('scope', 'custom', `${integration}/${metric} needs one query or page`);
  }

  if (baselineStart && baselineEnd) {
    if (baselineStart > baselineEnd) {
      issues.add('baseline_start', 'custom', 'baseline_start must be on or before baseline_end');
    } else if (registeredAt && baselineEnd > registeredAt.slice(0, 10)) {
      // A baseline that runs past the change is measuring the change against
      // itself: the baseline is the pre-change window. The refusal is the
      // field and its last valid date (bead `ro-ujb9.96.6.28`).
      issues.add('baseline_end', 'custom', `baseline_end must be on or before ${registeredAt.slice(0, 10)}`);
    } else if (offsets && offsets[offsets.length - 1]! < daySpan(baselineStart, baselineEnd)) {
      // The final post window is baseline-length and ends on the final check
      // date. If that check comes sooner than the baseline is long, the post
      // window reaches back past the change and the comparison is
      // contaminated — catch it at pre-registration, where it is still free.
      // The refusal is the field and its least valid value.
      issues.add(
        'check_offsets',
        'custom',
        `final check must be at least ${daySpan(baselineStart, baselineEnd)} days out`,
      );
    }
  }

  if (!issues.ok || !asset || !refKind || !ref || !integration || !metric || !registeredAt || !baselineStart || !baselineEnd || !offsets) {
    return { ok: false, error: 'validation', issues: issues.list };
  }

  if (!(await assetKnown(env.STORE, asset))) {
    return { ok: false, error: 'unknown_asset', asset };
  }

  const scopeJson = scope === null ? null : JSON.stringify(scope);

  // Idempotent on the bet itself — asset, what is watched, the series, the
  // scope. A spoke syncs its whole freeze register on every ship, so re-sending
  // is the normal case rather than the error case (the posture db/0022 set for
  // job runs). Closed windows count: a bet that has already been answered must
  // not quietly re-open because a sync ran again. The read and the write are
  // one transaction holding the bet, so two registrations of it at once are
  // one window (bead ro-ujb9.76.5.7).
  const bet: WatchBet = { asset, refKind, ref, integration, metric, scopeJson };
  return env.STORE.write(async (tx) => {
    await holdBet(tx, bet);
    const existing = await findBet(tx, bet);
    if (existing) return { ok: true, created: false, watchWindow: existing };

    const created = await insertWindow(tx, {
      ...bet,
      id: crypto.randomUUID(),
      registeredAt,
      baselineStart,
      baselineEnd,
      offsets,
      thresholdsJson: thresholds === null ? null : JSON.stringify(thresholds),
      note,
      readbackBead,
    });
    if (!created) {
      // A write that produced no row is never reported as a write that worked.
      throw new Error('watch_window_write_failed: insert returned no row');
    }
    return { ok: true, created: true, watchWindow: created };
  });
}

function validMetric(
  issues: Issues,
  value: unknown,
  integration: WatchIntegration | null,
): string | null {
  if (typeof value !== 'string') {
    issues.add('metric', 'invalid_type', 'metric must be a string');
    return null;
  }
  // Nothing to validate against until the integration itself is known; the
  // integration's own issue is already reported.
  if (!integration) return null;
  const allowed = Object.keys(WATCH_METRICS[integration]);
  if (!allowed.includes(value)) {
    issues.add(
      'metric',
      'invalid_value',
      `metric must be one of ${integration}: ${allowed.join(', ')}`,
    );
    return null;
  }
  return value;
}

function validOffsets(issues: Issues, value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    issues.add('check_offsets', 'invalid_type', 'check_offsets must be a non-empty array of whole days');
    return null;
  }
  if (value.length > WATCH_MAX_OFFSETS) {
    issues.add('check_offsets', 'too_big', `check_offsets must hold at most ${WATCH_MAX_OFFSETS} entries`);
    return null;
  }
  const offsets: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > WATCH_MAX_OFFSET_DAYS) {
      issues.add(
        'check_offsets',
        'invalid_value',
        `check_offsets entries must be whole days between 1 and ${WATCH_MAX_OFFSET_DAYS}`,
      );
      return null;
    }
    if (offsets.includes(entry)) {
      issues.add('check_offsets', 'custom', `check_offsets must not repeat an offset (${entry})`);
      return null;
    }
    offsets.push(entry);
  }
  // Stored sorted: the evaluator treats the largest offset as the final check.
  return offsets.sort((a, b) => a - b);
}

function validThresholds(issues: Issues, value: unknown): WatchThresholds | null {
  if (value === undefined || value === null) return null;
  const object = asObject(value);
  if (!object) {
    issues.add('thresholds', 'invalid_type', 'thresholds must be an object');
    return null;
  }
  const thresholds: WatchThresholds = {};
  for (const side of ['ship', 'kill'] as const) {
    const raw = object[side];
    if (raw === undefined || raw === null) continue;
    const threshold = asObject(raw);
    if (!threshold) {
      issues.add(`thresholds.${side}`, 'invalid_type', `thresholds.${side} must be an object`);
      continue;
    }
    const direction = enumValue(issues, threshold.direction, `thresholds.${side}.direction`, DIRECTIONS);
    const minDeltaPct = finiteNumber(
      issues,
      threshold.min_delta_pct,
      `thresholds.${side}.min_delta_pct`,
      { min: 0.01, max: 100_000 },
    );
    if (direction && minDeltaPct !== null) {
      thresholds[side] = { direction, min_delta_pct: minDeltaPct } satisfies WatchThreshold;
    }
  }
  if (!thresholds.ship && !thresholds.kill) {
    // Legal, and the evaluator says so at close: with nothing pre-registered
    // the window can only ever report the numbers and call it inconclusive.
    return null;
  }
  return thresholds;
}

function validScope(
  issues: Issues,
  value: unknown,
  integration: WatchIntegration | null,
): WatchScopeInput | null {
  if (value === undefined || value === null) return null;
  const scope = asObject(value);
  if (!scope) {
    issues.add('scope', 'invalid_type', 'scope must be an object');
    return null;
  }
  if (JSON.stringify(scope).length > WATCH_SCOPE_MAX_CHARS) {
    issues.add('scope', 'too_big', `scope must serialize to at most ${WATCH_SCOPE_MAX_CHARS} characters`);
    return null;
  }
  const keys = Object.keys(scope);
  if (keys.length !== 1 || (keys[0] !== 'query' && keys[0] !== 'page')) {
    issues.add('scope', 'invalid_value', 'scope names exactly one selector: query or page');
    return null;
  }
  // No other provider keeps a daily archive at query or page grain.
  if (integration !== 'gsc') {
    issues.add('scope', 'invalid_value', 'a query or page scope works only for gsc metrics');
    return null;
  }
  if (keys[0] === 'page') {
    const page = requiredString(issues, scope.page, 'scope.page', WATCH_PAGE_MAX_CHARS);
    return page ? { page } : null;
  }
  const query = requiredString(issues, scope.query, 'scope.query', WATCH_QUERY_MAX_CHARS);
  return query ? { query } : null;
}
