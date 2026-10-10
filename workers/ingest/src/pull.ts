// The PULL adapter (docs/02 §"Central signals", docs/06, docs/14-design.md § Operator flows baselining).
//
// NoticeOS runs local-first: prod assets that cannot reach the OS to *push*
// their nightly pulse are instead PULLED. A nightly cron fetches each enabled
// pull-mode asset's own self-report endpoint, turns the response into a contract
// envelope, and writes it through the SAME path as an inbound POST /api/pulse
// (validate → upsert → explode flags → central rules → resolve freshness), so a
// pulled asset is held to the identical contract as a pushed one. When an asset
// later starts pushing, flip its config/pull.json entry to `"enabled": false`
// and the two lanes never collide (the pull just stops).
//
// Two wire formats are supported, selected per asset by `format`:
//   - "prometheus": a Prometheus text scrape the adapter parses
//     and MAPS into the envelope, computing avg7d from stored pulse history.
//   - "envelope": the endpoint already speaks the contract and returns
//     the envelope verbatim. No metric mapping and no history-derived avg7d —
//     the source's own avg7d is authoritative. The adapter only validates it,
//     guards that its `asset` matches the configured id (never a silent
//     cross-write), and hands it to the shared path. Central rules still
//     re-evaluate with the OS's config; envelope flags still explode as
//     asset-declared — the format changes only how the body is obtained.
//
// Auth is a static bearer token per asset, read from env.ASSET_TOKENS — the ONE
// per-asset map. The same entry the push lane CHECKS inbound pulses against is
// what this lane PRESENTS on the way out, because an asset holds exactly one
// secret (its own ASSET_TOKEN) gating both directions.
// So a pulled endpoint is one gated on that static ASSET_TOKEN — a bearer a
// cron can present — never a session-gated admin page, which a machine cron
// cannot auth to (see workers/ingest/README §Pull mode).

import type { Metric, PulseEnvelope } from '@noticeos/contract';
import { ingestPulseEnvelope, type WritePulseResult } from './db.js';
import { EgressGate, type EgressRunOutcome } from './egress.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import { appendReading, holdCondition, raiseAlertUnlessOpen, readOpenAlert, resolveOpen } from './alert-store.js';
import pullConfigJson from '../../../config/pull.json';

/** rule id stamped on the flag raised when an asset's nightly pull fails. */
export const PULL_FAILED_RULE_ID = 'asset-pull-failed';

/** How many recent stored pulses feed the computed avg7d baseline (docs/14-design.md § Operator flows). */
const AVG7D_WINDOW = 7;

/** Fields common to every pull-mode asset config row (config/pull.json). */
interface PullAssetBase {
  asset: string;
  /** self-report endpoint fetched with a Bearer token from env.ASSET_TOKENS. */
  url: string;
  enabled: boolean;
}

/** A Prometheus text scrape the adapter parses and maps into the envelope. */
export interface PrometheusPullConfig extends PullAssetBase {
  format: 'prometheus';
  /** envelope metric name -> source counter (the Prometheus `table` label). */
  metrics: Record<string, { counter: string }>;
}

/** An endpoint that already returns the contract envelope verbatim. */
export interface EnvelopePullConfig extends PullAssetBase {
  format: 'envelope';
}

/** One pull-mode asset's config row — the wire format is the discriminant. */
export type PullAssetConfig = PrometheusPullConfig | EnvelopePullConfig;

const PULL_CONFIG = pullConfigJson as PullAssetConfig[];

const iso = (ms: number): string => new Date(ms).toISOString();
const pulseDay = (generatedAt: string): string => new Date(generatedAt).toISOString().slice(0, 10);

// --- Prometheus text parsing ------------------------------------------------

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse the exposition-format lines this endpoint emits, e.g.
 *   d1_row_count{table="profiles"} 4210
 *   d1_new_rows_count{table="profiles",window="24h"} 11
 * Comments/HELP/TYPE and unparseable lines are skipped. The endpoint's labels
 * are simple identifiers (no escaped quotes), so a compact matcher suffices.
 */
export function parsePrometheus(text: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?[0-9.eE+]+)$/.exec(line);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (m[2]) {
      for (const pair of m[2].split(',')) {
        const lm = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/.exec(pair);
        if (lm) labels[lm[1]!] = lm[2]!;
      }
    }
    samples.push({ name: m[1]!, labels, value });
  }
  return samples;
}

/**
 * The all-time total for one source counter (`d1_row_count{table}`), or
 * undefined when the scrape carries no such sample. Deliberately non-throwing:
 * the counters lane needs the absence as a value it can turn into a
 * whole-property failure, not an exception mid-loop.
 */
export function totalFor(samples: PromSample[], counter: string): number | undefined {
  return samples.find((s) => s.name === 'd1_row_count' && s.labels.table === counter)?.value;
}

/** total (all-time) + last24h counts for one source counter, or throw if absent. */
function extractCounts(samples: PromSample[], counter: string): { last24h: number; total: number } {
  const total = totalFor(samples, counter);
  const last24h = samples.find(
    (s) => s.name === 'd1_new_rows_count' && s.labels.table === counter && s.labels.window === '24h',
  )?.value;
  if (total === undefined) throw new Error(`no d1_row_count for table "${counter}"`);
  if (last24h === undefined) {
    throw new Error(`no d1_new_rows_count{window="24h"} for table "${counter}"`);
  }
  return { last24h, total };
}

// --- avg7d baseline from stored history (docs/14-design.md § Operator flows) -------------------------

/**
 * Per-metric avg7d computed from the last {@link AVG7D_WINDOW} stored pulses for
 * the asset (days strictly before today, so a same-day re-pull never skews it).
 * With no stored history a metric falls back to its current last24h — which
 * makes the central drop rule a no-op (observed == baseline) until a real
 * baseline accumulates, exactly the docs/14-design.md § Operator flows "arm the rules after baselining"
 * intent. The source's own point-in-time counts are never trusted as baselines.
 */
async function computeAvg7d(
  env: IngestEnv,
  asset: string,
  metricNames: string[],
  today: string,
  currentLast24h: Record<string, number>,
): Promise<Record<string, number>> {
  // Each day's newest revision (`noticeos.current_pulses`, bead
  // ro-ujb9.76.5.2): the one report D1 kept per day.
  const priors = await env.STORE.read((tx) =>
    tx.query<{ envelope: string }>(
      `SELECT envelope::text AS envelope FROM noticeos.current_pulses
        WHERE asset_id = $1 AND pulse_date < $2::date
        ORDER BY pulse_date DESC LIMIT $3`,
      [asset, today, AVG7D_WINDOW],
    ),
  );

  const parsed = priors
    .map((r) => {
      try {
        return JSON.parse(r.envelope) as PulseEnvelope;
      } catch {
        return null;
      }
    })
    .filter((e): e is PulseEnvelope => e !== null);

  const out: Record<string, number> = {};
  for (const name of metricNames) {
    const values: number[] = [];
    for (const prev of parsed) {
      const v = prev.metrics?.[name]?.last24h;
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
    out[name] =
      values.length > 0
        ? values.reduce((a, b) => a + b, 0) / values.length
        : (currentLast24h[name] ?? 0);
  }
  return out;
}

/** Map a fetched Prometheus scrape body into the contract envelope for `entry.asset`. */
async function prometheusToEnvelope(
  env: IngestEnv,
  entry: PrometheusPullConfig,
  body: string,
  nowMs: number,
): Promise<PulseEnvelope> {
  const names = Object.keys(entry.metrics);
  if (names.length === 0) throw new Error('no metrics configured for asset');

  const samples = parsePrometheus(body);
  const raw: Record<string, { last24h: number; total: number }> = {};
  for (const [name, map] of Object.entries(entry.metrics)) {
    raw[name] = extractCounts(samples, map.counter);
  }

  const generatedAt = iso(nowMs);
  const currentLast24h: Record<string, number> = {};
  for (const name of names) currentLast24h[name] = raw[name]!.last24h;
  const avg7d = await computeAvg7d(env, entry.asset, names, pulseDay(generatedAt), currentLast24h);

  const metrics: Record<string, Metric> = {};
  for (const name of names) {
    metrics[name] = {
      last24h: raw[name]!.last24h,
      avg7d: avg7d[name] ?? raw[name]!.last24h,
      total: raw[name]!.total,
    };
  }
  return { asset: entry.asset, generatedAt, capabilities: names, metrics };
}

// --- envelope format (the endpoint already speaks the contract) -------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A provider's own error shape ({ error, message }) — e.g. a site's 401/502/503. */
interface ProviderError {
  error?: string;
  message?: string;
}

/**
 * A pull failure that carries the provider's own error shape so the operator
 * sees the source's own words in the alert message and `rule_inputs` (doc 14
 * flow C spirit), not just an HTTP status.
 */
class PullError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly provider?: ProviderError,
  ) {
    super(message);
    this.name = 'PullError';
  }
}

/** Render a non-200 into the operator-facing string "<status> <error> — <message>". */
function renderProviderFailure(status: number, provider: ProviderError | undefined, rawBody: string): string {
  if (provider?.error && provider.message) return `${status} ${provider.error} — ${provider.message}`;
  if (provider?.error) return `${status} ${provider.error}`;
  if (provider?.message) return `${status} ${provider.message}`;
  const snippet = rawBody.trim().slice(0, 200);
  return snippet ? `non-200 response (${status}): ${snippet}` : `non-200 response (${status})`;
}

/** Turn a non-200 envelope response into a PullError, surfacing any {error,message} body. */
async function providerFailure(res: Response): Promise<PullError> {
  const status = res.status;
  const rawBody = await res.text().catch(() => '');
  let provider: ProviderError | undefined;
  try {
    const json: unknown = JSON.parse(rawBody);
    if (isRecord(json)) {
      const error = typeof json.error === 'string' ? json.error : undefined;
      const message = typeof json.message === 'string' ? json.message : undefined;
      if (error !== undefined || message !== undefined) provider = { error, message };
    }
  } catch {
    /* non-JSON error body — the status-only rendering covers it. */
  }
  return new PullError(renderProviderFailure(status, provider, rawBody), status, provider);
}

/**
 * Read an "envelope"-format response into the raw body to validate downstream.
 * Non-200s surface the provider's own error; a 200 body must be a JSON object
 * whose `asset` matches the configured id — a mismatch is a pull failure, never
 * a silent cross-write. The contract itself is validated later (shared path).
 */
async function envelopeFromResponse(entry: EnvelopePullConfig, res: Response): Promise<unknown> {
  if (res.status !== 200) throw await providerFailure(res);
  const rawBody = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error('response body is not valid JSON');
  }
  const declared = isRecord(body) ? body.asset : undefined;
  if (declared !== entry.asset) {
    throw new Error(`envelope asset mismatch: expected "${entry.asset}", got ${JSON.stringify(declared)}`);
  }
  return body;
}

// --- pull-failure flag (mirrors the freshness flag's fire/resolve rules) -----

/** What a pull-failure flag persists in `rule_inputs`, rewritten on every failure. */
interface PullFailureInputs {
  rule: typeof PULL_FAILED_RULE_ID;
  url: string;
  status: number | null;
  error: string;
  /** The provider's own error name + message, verbatim, when it sent one. */
  providerError?: string;
  providerMessage?: string;
  /** Failed pulls since this flag opened — 1 on the night it fired. */
  failureCount: number;
  /** Most recent failure; the row's `fired_at` stays the FIRST one. */
  lastFailedAt: string;
  evaluatedAt: string;
}

/** The running failure count carried by an open flag's inputs (0 if unreadable). */
function priorFailureCount(ruleInputs: string | null | undefined): number {
  if (!ruleInputs) return 0;
  try {
    const prev = JSON.parse(ruleInputs) as Partial<PullFailureInputs>;
    return typeof prev.failureCount === 'number' && Number.isFinite(prev.failureCount)
      ? prev.failureCount
      : 0;
  } catch {
    return 0;
  }
}

/** Whether a failure's own record was kept (`noticeos.flag_evidence`). A
 * Postgres store always keeps it; `not-migrated` was a D1 store without
 * db/0040. */
export type FlagEvidenceWrite = 'recorded';

export interface PullFailureFlagWrite {
  /** 1 when a new flag row was inserted. */
  fired: number;
  /** 1 when an already-open flag took this failure as its newest reading. */
  refreshed: number;
  /** Whether this failure's own record was kept (`flag_evidence`). */
  evidence: FlagEvidenceWrite;
}

/**
 * Raise a warn `asset-pull-failed` flag on the asset — but only when no open one
 * already exists, so a persistent outage does not fire a flag every night.
 * When one IS open the failure becomes its NEWEST READING (message +
 * rule_inputs) rather than being dropped: a multi-night outage can change cause
 * between nights (401 after a 503, say), and an operator reading a flag frozen
 * at the first night's cause is chasing the wrong thing. `fired_at` stays the
 * first night, so the alert still dates the outage's start, and
 * `failureCount`/`lastFailedAt` in the inputs carry how long it has been going.
 * pulse_id is NULL (centrally computed, like ingest-freshness).
 *
 * EVERY NIGHT KEEPS ITS OWN RECORD (bead `ro-ujb9.220`): each failure, the
 * first included, appends its reading to `noticeos.flag_evidence` on the alert
 * it opened or joined, and the alert reads as its newest (`current_flags`,
 * bead ro-ujb9.76.5.2; D1 rewrote the flag row as well). N failed nights leave
 * N readings, and the Tower lists them on the site's Data sources tab and in
 * the alert's Evidence.
 */
async function firePullFailure(
  env: IngestEnv,
  asset: string,
  url: string,
  status: number | null,
  error: string,
  provider: ProviderError | undefined,
  failedAt: string,
): Promise<PullFailureFlagWrite> {
  return env.STORE.write(async (tx) => {
    await holdCondition(tx, asset, PULL_FAILED_RULE_ID);
    const open = await readOpenAlert(tx, asset, PULL_FAILED_RULE_ID);

    const inputs: PullFailureInputs = {
      rule: PULL_FAILED_RULE_ID,
      url,
      status,
      error,
      ...(provider?.error !== undefined ? { providerError: provider.error } : {}),
      ...(provider?.message !== undefined ? { providerMessage: provider.message } : {}),
      failureCount: priorFailureCount(open?.ruleInputs) + 1,
      lastFailedAt: failedAt,
      evaluatedAt: failedAt,
    };
    // The message deliberately does NOT name the property — the flag row's
    // `asset` column carries that fact, and the attention band renders it from
    // there (doc 14 one-representation rule; a prefixed message would read
    // "Example: example.com pull failed…").
    const message = `pull failed: ${error}`;
    const serialized = JSON.stringify(inputs);
    const reading = { observedAt: failedAt, severity: 'warn', message, ruleInputs: serialized };

    // This night's record lands on exactly the alert it opened or joined: a
    // new firing, or every open one of this condition (D1 rewrote each).
    if (open === null) {
      const flagId = await raiseAlertUnlessOpen(tx, {
        asset,
        firedAt: failedAt,
        severity: 'warn',
        kind: 'anomaly',
        metric: null,
        message,
        ruleId: PULL_FAILED_RULE_ID,
        ruleInputs: serialized,
      });
      if (flagId !== null) await appendReading(tx, [flagId], reading);
      return { fired: flagId === null ? 0 : 1, refreshed: 0, evidence: 'recorded' };
    }
    const openIds = (
      await tx.query<{ flag_id: bigint }>(
        `SELECT flag_id FROM noticeos.flags
          WHERE asset_id = $1 AND rule_id = $2 AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL`,
        [asset, PULL_FAILED_RULE_ID],
      )
    ).map((row) => row.flag_id);
    await appendReading(tx, openIds, reading);
    return { fired: 0, refreshed: openIds.length, evidence: 'recorded' };
  });
}

/** Resolve any open pull-failure flag for the asset (a successful pull clears it). */
async function resolvePullFailure(env: IngestEnv, asset: string, resolvedAt: string): Promise<number> {
  return env.STORE.write((tx) => resolveOpen(tx, asset, PULL_FAILED_RULE_ID, resolvedAt));
}

/** Look up an asset's token from the env.ASSET_TOKENS JSON map. */
export function tokenFor(assetTokensJson: string | undefined, asset: string): string | null {
  if (!assetTokensJson) return null;
  try {
    const map = JSON.parse(assetTokensJson) as Record<string, unknown>;
    const token = map[asset];
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * GET a property's self-report endpoint with its pull bearer. The one place the
 * outbound scrape is shaped, so every lane reading a property's own endpoint
 * (nightly pull, counters) presents the identical request — a property's worker
 * only ever has to authorize one caller shape.
 */
export function fetchScrape(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  accept: string,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept },
  });
}

/** A compact, non-sensitive summary of a contract validation failure. */
function summarizeParseError(error: { issues: ReadonlyArray<{ path: PropertyKey[]; code: string }> }): string {
  return (
    error.issues
      .slice(0, 3)
      .map((i) => `${i.path.map(String).join('.') || '<root>'}:${i.code}`)
      .join('; ') || 'invalid envelope'
  );
}

// --- the adapter ------------------------------------------------------------

export interface PullAssetOutcome {
  asset: string;
  ok: boolean;
  status: number | null;
  /** number of pull-failure flags fired this run (0 or 1). */
  fired: number;
  /** number of already-open pull-failure flags rewritten with this failure (0 or 1). */
  refreshed: number;
  /** number of open pull-failure flags resolved this run (success path). */
  resolved: number;
  /** On a failure that filed or refreshed the flag: whether that night's own
   * record was kept (`flag_evidence`, db/0040), or the store predates it. */
  evidence?: FlagEvidenceWrite;
  /**
   * True when the fetch failed but the OS's own egress is what was down, so NO
   * `asset-pull-failed` flag was filed. The pull still counts as failed — it did
   * not happen — but the property is not the reason, and the run's single
   * `os-egress-down` flag carries that fact instead (src/egress.ts).
   */
  egressDown?: boolean;
  error?: string;
  result?: WritePulseResult;
}

export interface PullAdapterResult {
  attempted: number;
  succeeded: number;
  failed: number;
  outcomes: PullAssetOutcome[];
  /** What the run's egress gate concluded — see {@link EgressRunOutcome}. */
  egress: EgressRunOutcome;
}

export interface PullOptions {
  /** Override the built-in config/pull.json (tests inject their own entries). */
  entries?: PullAssetConfig[];
  /** Override the outbound fetcher (tests stub the self-report responses). */
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** Override the run's egress gate (tests control the verdict TTL); every other
   * caller gets a real one over the same fetcher. */
  egress?: EgressGate;
  /** Where this run's config came from, per file — resolved once per cron fire
   * in dispatch.ts and reported on the completion line below (`ro-syok.7`). */
  configSources?: ConfigSourceMap;
}

/** Pull one asset end-to-end; never throws — failures become a flag + outcome. */
async function pullOne(
  env: IngestEnv,
  entry: PullAssetConfig,
  fetchImpl: typeof fetch,
  gate: EgressGate,
  nowMs: number,
): Promise<PullAssetOutcome> {
  const at = iso(nowMs);
  let status: number | null = null;
  // Whether a request was actually put on the wire. A missing token also leaves
  // `status` null, and that failure is configuration, not connectivity — it must
  // still flag while the house internet is out.
  let attempted = false;
  try {
    const token = tokenFor(env.ASSET_TOKENS, entry.asset);
    if (!token) throw new Error('no pull token configured for asset');

    const accept = entry.format === 'envelope' ? 'application/json' : 'text/plain';
    attempted = true;
    const res = await fetchScrape(fetchImpl, entry.url, token, accept);
    status = res.status;

    // Obtain the contract-envelope body per wire format; the shared path below
    // is identical for both (validate → upsert → flags → central rules).
    let body: unknown;
    if (entry.format === 'envelope') {
      body = await envelopeFromResponse(entry, res);
    } else {
      if (res.status !== 200) throw new Error(`non-200 response (${res.status})`);
      body = await prometheusToEnvelope(env, entry, await res.text(), nowMs);
    }

    const outcome = await ingestPulseEnvelope(env, body);
    if (!outcome.ok) {
      const label = entry.format === 'envelope' ? 'pulled envelope' : 'mapped envelope';
      throw new Error(`${label} failed contract validation (${summarizeParseError(outcome.error)})`);
    }

    const resolved = await resolvePullFailure(env, entry.asset, at);
    return { asset: entry.asset, ok: true, status, fired: 0, refreshed: 0, resolved, result: outcome.result };
  } catch (err) {
    const provider = err instanceof PullError ? err.provider : undefined;
    const error = err instanceof Error ? err.message : String(err);
    // A pull that came back with no status is the one failure that may not be
    // the property's: on 2026-08-08 both pull-mode properties were flagged for
    // an outage that was the OS's own uplink. Any status the endpoint returned —
    // 401, 404, 503 — proves the request got there, and is never gated.
    if (status === null && attempted && (await gate.isDown())) {
      gate.recordUnmeasured(entry.asset);
      return {
        asset: entry.asset,
        ok: false,
        status,
        fired: 0,
        refreshed: 0,
        resolved: 0,
        egressDown: true,
        error,
      };
    }
    const { fired, refreshed, evidence } = await firePullFailure(
      env,
      entry.asset,
      entry.url,
      status,
      error,
      provider,
      at,
    );
    return { asset: entry.asset, ok: false, status, fired, refreshed, resolved: 0, evidence, error };
  }
}

/**
 * Nightly pull cron (02:30 UTC, before the 03:00 asset-#0 self-pulse). Pulls
 * every enabled pull-mode asset independently: one asset's failure is caught,
 * flagged, and never aborts the others.
 */
export async function runPullAdapter(env: IngestEnv, opts: PullOptions = {}): Promise<PullAdapterResult> {
  const entries = (opts.entries ?? PULL_CONFIG).filter((e) => e.enabled);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  // One gate for the run, finalized below: two properties unreachable on the
  // same dead uplink is one fact about this OS, not two about them.
  const gate = opts.egress ?? new EgressGate(env, { lane: 'pull', fetchImpl, at: iso(nowMs) });

  const outcomes: PullAssetOutcome[] = [];
  for (const entry of entries) {
    outcomes.push(await pullOne(env, entry, fetchImpl, gate, nowMs));
  }
  const succeeded = outcomes.filter((o) => o.ok).length;
  const result = {
    attempted: entries.length,
    succeeded,
    failed: outcomes.length - succeeded,
    outcomes,
    egress: await gate.finalize(),
  };
  // ONE COMPLETION LINE, and the reason it exists is `configSource` (bead
  // `ro-syok.7`): this lane's registry moved into the store, and a run that
  // cannot say which of the two it read leaves an operator to infer it from
  // behaviour. Counts and asset ids only — a pull URL carries no token, but the
  // registry itself never reaches a log either way.
  console.log(
    JSON.stringify({
      event: 'pull_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
      ...configSourceLine(opts.configSources, ['config/pull.json']),
      errors: outcomes
        .filter((outcome) => !outcome.ok)
        .map(({ asset, status }) => ({ asset, status })),
    }),
  );
  return result;
}
