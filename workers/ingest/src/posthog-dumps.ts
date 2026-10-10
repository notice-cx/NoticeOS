import { tryHealthConnection } from './integration-health-context.js';
import { beginCollection, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
// PostHog product analytics archive: once a day, per asset with a key and a
// saved region + project, six aggregate families are read from the query API
// and archived through the ordinary signal-dump path.
//
// Read-only, two endpoints: the project read (timezone, and proof the key can
// read the project) and `POST .../query/` with a HogQLQuery. Every query
// aggregates server-side, filters to its window on `timestamp` and carries an
// explicit LIMIT of the contract bound plus one (the extra row detects
// truncation). Families run one after another; a 429 stops the whole run, and
// a family not yet asked is recorded as skipped, never as an attempt. One run
// per asset at a time (`claimPosthogLease`). A call that never came back asks
// the egress gate before PostHog is blamed; because every query is bounded to
// its window, a missed window can be asked for again (`owedWindows`).

import {
  POSTHOG_FAMILIES,
  POSTHOG_LANE_ID,
  POSTHOG_ROW_LIMITS,
  POSTHOG_WEB_VITALS_TOP_PATHS,
  POSTHOG_WINDOW_DAYS,
  POSTHOG_MESSAGE_MAX,
  POSTHOG_ELEMENT_TEXT_MAX,
  posthogArchiveBodySchema,
  type PosthogArchiveBody,
  type PosthogAssetSettings,
  type PosthogFamily,
  type PosthogFunnel,
  type PosthogHost,
} from '@noticeos/contract';
import {
  archiveCollectedDump,
  archiveDumpFailure,
  archivePart,
  archivePartKey,
  LOCAL_STORE_FAILED,
  networkFailure,
  parseDatedArchivePart,
  unmeasuredDumpOutcome,
  type DumpPage,
  type DumpTarget,
  type SignalDumpOutcome,
} from './signal-dumps.js';
import {
  EgressGate,
  egressExplains,
  openEgressLaneRecord,
  watchTransport,
  type EgressRunOutcome,
  type TransportWatch,
} from './egress.js';
import { recordCredentialOutcome, resolveCredential, sourcedCredentialRef } from './credentials.js';
import { failureWords } from './integration-health-store.js';
import { POSTHOG_ACCOUNT_KEY_SLOT } from './posthog-account.js';
import { laneDeclined, posthogSettings, type LaneRegister } from './lane-mapping.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import { boundedResponseJson, normalizeSignalError, SignalError } from './signal-store.js';
import { dateInTimeZone, isValidTimeZone, shiftCalendarDate } from './time-zone.js';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import { SITE_ORDER } from '@noticeos/contract';
import { asRecord, stringField } from './shared.js';
import { claimLease } from './integration-leases.js';

/** The credential field: asset id → that asset's read-only personal API key. */
export const POSTHOG_KEY_SLOT = 'POSTHOG_KEYS';
/** Every PostHog request is cut off after this long by its abort signal. */
export const POSTHOG_REQUEST_TIMEOUT_MS = 30_000;
/**
 * At most this many earlier window ends are asked again per asset per run: one
 * dark night's worth. Each re-asked window re-reads its whole trailing range
 * against the project's hourly bytes-read budget.
 */
export const POSTHOG_RETRY_LIMIT = POSTHOG_FAMILIES.length;
/**
 * How long a run may hold one asset's PostHog lease: several times the longest
 * run over one asset (thirteen requests at `POSTHOG_REQUEST_TIMEOUT_MS`), so a
 * live run is never mistaken for a dead one and a run killed mid-await frees
 * the asset before the next daily run.
 */
export const POSTHOG_LEASE_MS = 30 * 60_000;
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;
/** A refusal page that is not JSON still has a status worth reporting. */
const POSTHOG_RESPONSE = { invalidJsonCode: 'posthog_invalid_response', refusalMayBeText: true };
const BUDGET_HEADER = 'x-posthog-query-budget-remaining-bytes';
const BYTES_READ_HEADER = 'x-posthog-query-bytes-read';
/** An explicit window may be at most this long: the web-daily bound. */
export const POSTHOG_MAX_EXPLICIT_WINDOW_DAYS = POSTHOG_ROW_LIMITS['web-daily'];

const HOST_ORIGIN: Record<PosthogHost, string> = {
  us: 'https://us.posthog.com',
  eu: 'https://eu.posthog.com',
};

/** The API origin for a PostHog Cloud region. */
export function posthogOrigin(host: PosthogHost): string {
  return HOST_ORIGIN[host];
}

/** Why an (asset, family) was not asked for. Recorded on the result and the
 * completion line; never a manifest row. */
export type PosthogSkipReason =
  | 'not-configured'
  | 'no-key'
  | 'mapping-missing'
  | 'mapping-invalid'
  | 'no-funnels'
  | 'budget-exhausted'
  | 'rate-limited'
  | 'in-flight';

/** The run that already holds an asset's lease, as the run it turned away
 * reports it. */
export interface PosthogRunInFlight {
  /** When the holding run claimed the asset. */
  startedAt: string;
  /** How long ago that was, in whole seconds. */
  runningSeconds: number;
  /** When the asset frees itself even if the holder never returns. */
  leaseExpiresAt: string;
}

export interface PosthogSkip {
  asset: string;
  /** Null when the whole asset was skipped before any family was chosen. */
  family: PosthogFamily | null;
  reason: PosthogSkipReason;
  detail: string;
  /** Only on an `in-flight` skip: the run that holds the asset. */
  inFlight?: PosthogRunInFlight;
}

export interface PosthogWindow {
  start: string;
  end: string;
}

/** An on-demand run: one asset, optionally some families and a fixed window. */
export interface PosthogCollectScope {
  asset: string;
  families?: PosthogFamily[];
  window?: PosthogWindow;
}

export interface PosthogDumpsOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** Raw `POSTHOG_KEYS` JSON (tests inject their own). */
  rawKeys?: string;
  /** The per-asset region/project/funnels register (store-first per fire). */
  laneRegister?: LaneRegister;
  configSources?: ConfigSourceMap;
  scope?: PosthogCollectScope;
  /** The lease clock. Windows are dated from `nowMs`; a lease is dated when it
   * is taken, because a later asset in a long run must still hold its lease for
   * the full `POSTHOG_LEASE_MS`. */
  clock?: () => number;
  /** Override the run's egress gate (tests control the verdict TTL). */
  egress?: EgressGate;
  /** Override {@link POSTHOG_RETRY_LIMIT} (tests pin the bound; 0 asks nothing again). */
  retryLimit?: number;
}

export interface PosthogDumpsResult {
  attempted: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  skipped: PosthogSkip[];
  /** True when PostHog refused a query with 429 and the run stopped early. */
  budgetStopped: boolean;
  /** The last `X-PostHog-Query-Budget-Remaining-Bytes` PostHog sent, or null. */
  budgetRemainingBytes: number | null;
  /** Bytes PostHog reported reading across this run's queries. */
  bytesRead: number;
  /** Earlier window ends this run asked again, already counted in `attempted`. */
  retried: number;
  /** Those earlier windows' outcomes, the same objects as in `outcomes`. */
  recollected: SignalDumpOutcome[];
  /** Owed earlier windows this run found and left for the next one: the bound,
   * or a pass the connection or PostHog cut short. */
  retryNotAsked: number;
  outcomes: SignalDumpOutcome[];
  /** What the run's egress gate concluded — see {@link EgressRunOutcome}. */
  egress: EgressRunOutcome;
  monitoringAvailable?: false;
}

interface PosthogTarget extends DumpTarget {
  integration: 'posthog';
}

interface Candidate {
  asset: string;
  domain: string;
}

/** The run's egress question, carried to every PostHog call. */
interface EgressLane {
  gate: EgressGate;
  transport: TransportWatch;
}

/** One earlier window end owed a re-collection. */
interface OwedWindow {
  family: PosthogFamily;
  end: string;
}

/**
 * Earlier runs a PostHog 429 stopped, and what each asset has on record around
 * them, so `assetAsks` can date the windows those runs never asked.
 */
interface StoppedRuns {
  /** The shared `requested_at` of each run a 429 stopped, oldest first. */
  runs: string[];
  /** Per asset, on its current project: its first recorded attempt, and every
   * `family\0window end` it has any row for at a date those runs could have asked. */
  assets: Map<string, { since: string; recorded: Set<string> }>;
}

/** The run's re-collection pass. */
interface RetryPass {
  /** Per asset, every window end owed before the bound — read once per run. */
  owed: Map<string, OwedWindow[]>;
  /** The runs a 429 stopped, whose unasked windows are owed too. */
  stopped: StoppedRuns;
  /** At most this many are asked per asset. */
  limit: number;
  /** False once this run has seen the connection fail: nothing more is asked. */
  open: boolean;
  /** Owed window ends this run found for the assets it reached. */
  found: number;
  /** …and the ones it asked. */
  asked: number;
  /** What each of those asks came back with, in the order asked. */
  outcomes: SignalDumpOutcome[];
}

/** Shared state for one run: whether PostHog has told us to stop. */
interface RunState {
  stop: { reason: 'budget-exhausted' | 'rate-limited'; detail: string } | null;
  budgetRemainingBytes: number | null;
  bytesRead: number;
  retry: RetryPass;
}

export async function runPosthogDumps(
  env: IngestEnv,
  options: PosthogDumpsOptions = {},
): Promise<PosthogDumpsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const clock = options.clock ?? Date.now;
  const requestedAt = new Date(nowMs).toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = await resolveCredential(env, 'posthog');
  const health = await tryHealthConnection(env, 'posthog', resolved);
  const monitoring = beginCollection(env.STORE, health);
  const keys = resolvePosthogKeys(options.rawKeys ?? resolved.fields[POSTHOG_KEY_SLOT]);
  const credentialRef = sourcedCredentialRef(
    POSTHOG_KEY_SLOT,
    options.rawKeys === undefined ? resolved.source : 'env',
  );
  // The account's one key: every site without a key of its own in the older
  // per-site map reads its mapped project with it.
  const accountKey = options.rawKeys === undefined ? resolved.fields[POSTHOG_ACCOUNT_KEY_SLOT] : undefined;
  const accountRef = sourcedCredentialRef(POSTHOG_ACCOUNT_KEY_SLOT, resolved.source);
  const keyFor = (asset: string): { key: string; ref: string } | undefined => {
    const own = keys.get(asset);
    if (own !== undefined) return { key: own, ref: credentialRef };
    return accountKey ? { key: accountKey, ref: accountRef } : undefined;
  };

  // One gate per run, asked only about a PostHog call that came back with no
  // status; its beacons use the raw fetcher.
  const egress: EgressLane = {
    gate: options.egress ?? new EgressGate(env, { lane: 'posthog', fetchImpl, at: requestedAt }),
    transport: watchTransport(fetchImpl),
  };

  // Declined on its Data sources row (Not using): not asked for.
  let candidates = (await posthogCandidates(env.STORE))
    .filter((c) => !laneDeclined(c.asset, 'posthog', options.laneRegister));
  if (options.scope) candidates = candidates.filter((c) => c.asset === options.scope!.asset);
  const outcomes: SignalDumpOutcome[] = [];
  const skipped: PosthogSkip[] = [];
  const state: RunState = {
    stop: null,
    budgetRemainingBytes: null,
    bytesRead: 0,
    retry: {
      owed: new Map(),
      stopped: { runs: [], assets: new Map() },
      limit: Math.max(0, options.retryLimit ?? POSTHOG_RETRY_LIMIT),
      open: true,
      found: 0,
      asked: 0,
      outcomes: [],
    },
  };

  // Decide every asset's plan before touching the store or PostHog, so a run
  // with nothing to do writes nothing and asks nothing.
  const plans: { candidate: Candidate; key: string; ref: string; settings: PosthogAssetSettings }[] = [];
  for (const candidate of candidates) {
    const held = keyFor(candidate.asset);
    const key = held?.key;
    const read = posthogSettings(candidate.asset, options.laneRegister);
    if (key === undefined && !read.ok && read.reason === 'mapping_missing') {
      skipped.push({ asset: candidate.asset, family: null, reason: 'not-configured', detail: 'No PostHog key or project for this site' });
      continue;
    }
    if (key === undefined) {
      // A state and where it is fixed.
      skipped.push({ asset: candidate.asset, family: null, reason: 'no-key', detail: 'PostHog project saved · no PostHog key connected' });
      continue;
    }
    if (!read.ok) {
      skipped.push({
        asset: candidate.asset,
        family: null,
        reason: read.reason === 'mapping_missing' ? 'mapping-missing' : 'mapping-invalid',
        detail: read.detail,
      });
      continue;
    }
    plans.push({ candidate, key, ref: held!.ref, settings: read.settings });
  }

  // The earlier window ends an outage cost, read once. A run pinned to an
  // explicit window reproduces that window and nothing else.
  if (plans.length > 0 && options.scope?.window === undefined && state.retry.limit > 0) {
    state.retry.owed = await owedWindows(env, plans);
    state.retry.stopped = await stoppedRuns(env.STORE, plans);
  }

  for (const { candidate, key, ref, settings } of plans) {
    const target: PosthogTarget = {
      asset: candidate.asset,
      integration: 'posthog',
      credentialRef: ref,
      propertyRef: posthogPropertyRef(settings),
    };
    const families = (options.scope?.families ?? [...POSTHOG_FAMILIES]).filter((family) => {
      if (family === 'funnels' && settings.funnels.length === 0) {
        skipped.push({ asset: candidate.asset, family, reason: 'no-funnels', detail: 'No funnels picked for this site' });
        return false;
      }
      return true;
    });
    if (families.length === 0) continue;
    if (state.stop !== null) {
      for (const family of families) skipped.push({ asset: candidate.asset, family, ...state.stop });
      continue;
    }
    // Taken inside the collector, so every door asks for it by construction;
    // the route turns an `in-flight` skip into its 409.
    const lease = await claimPosthogLease(env.STORE, candidate.asset, clock());
    if (lease.owner === null) {
      skipped.push({
        asset: candidate.asset,
        family: null,
        reason: 'in-flight',
        detail: posthogInFlightDetail(candidate.asset, lease.heldBy),
        inFlight: lease.heldBy,
      });
      continue;
    }
    try {
      outcomes.push(
        ...(await collectAsset(env, {
          target,
          key,
          settings,
          families,
          window: options.scope?.window,
          nowMs,
          requestedAt,
          egress,
          monitoring,
          state,
          skipped,
        })),
      );
    } finally {
      // Every exit: success, provider failures, a 429 budget stop (collectAsset
      // returns normally with `state.stop` set) and anything thrown.
      await releasePosthogLease(env.STORE, candidate.asset, lease.owner);
    }
  }

  // What this run answered for on the flag's `posthog` entry: a window end
  // leaves it once something asked for that exact window and heard back, or
  // once nothing will ever ask for it again. A scoped run answers only for its
  // own asset and families.
  const answered = new Set(
    outcomes
      .filter((outcome) => !outcome.egressDown)
      .map((outcome) => archivePartKey(outcome.asset, archivePart('posthog', outcome.report, outcome.reportDate))),
  );
  const planned = new Map(plans.map(({ candidate, settings }) => [candidate.asset, settings]));
  const covers = (asset: string, part: string | null): boolean => {
    if (options.scope !== undefined && options.scope.asset !== asset) return false;
    const settings = planned.get(asset);
    if (settings === undefined) return true;
    const dated = part === null ? null : parseDatedArchivePart(part);
    if (dated === null || dated.integration !== 'posthog') return true;
    const family = dated.report as PosthogFamily;
    if (!POSTHOG_FAMILIES.includes(family) || (family === 'funnels' && settings.funnels.length === 0)) return true;
    if (options.scope?.families !== undefined && !options.scope.families.includes(family)) return false;
    return answered.has(archivePartKey(asset, part!));
  };
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  // PostHog answered these, and this machine could not keep the answer.
  const storeFailed = measured.filter((outcome) => outcome.errorCode === LOCAL_STORE_FAILED);
  const posthogAnswered = measured.filter((outcome) => outcome.errorCode !== LOCAL_STORE_FAILED);

  const result = {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    unchanged: outcomes.filter((outcome) => outcome.status === 'unchanged').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    skipped,
    budgetStopped: state.stop !== null,
    budgetRemainingBytes: state.budgetRemainingBytes,
    bytesRead: state.bytesRead,
    retried: state.retry.asked,
    recollected: state.retry.outcomes,
    retryNotAsked: state.retry.found - state.retry.asked,
    outcomes,
    // One `os-egress-down` fact for the whole night — or the retraction of one
    // an earlier run left open.
    egress: await egress.gate.finalize({ covers }),
  };

  // The run is the proof the stored keys work. A window the dead uplink
  // swallowed, or one this machine failed to save, says nothing about the key.
  if (resolved.source === 'store' && options.rawKeys === undefined && posthogAnswered.length > 0) {
    const failures = posthogAnswered.filter((outcome) => outcome.status === 'error');
    await recordCredentialOutcome(env, 'posthog', {
      ok: failures.length < posthogAnswered.length,
      // One short line in the words the site's own row uses, then the count.
      error:
        failures.length === 0
          ? null
          : [
              ...failureWords(failures.map(({ errorCode }) => errorCode)),
              `${failures.length} of ${posthogAnswered.length} reports`,
            ].join(' · '),
      at: requestedAt,
    });
  }

  console.log(
    JSON.stringify({
      event: 'posthog_dumps_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      ...configSourceLine(options.configSources, ['config/integrations.json']),
      budgetStopped: result.budgetStopped,
      budgetRemainingBytes: result.budgetRemainingBytes,
      bytesRead: result.bytesRead,
      skipped: skipped.map(({ asset, family, reason }) => ({ asset, family, reason })),
      // Earlier window ends asked again, and how many owed ones were left.
      retried: result.retried,
      retryNotAsked: result.retryNotAsked,
      // PostHog's failures only: an unmeasured window and a store failure are
      // counted elsewhere, never listed as PostHog's error.
      errors: posthogAnswered
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, report, reportDate, errorCode }) => ({ asset, report, reportDate, errorCode })),
      storeErrors: storeFailed.map(({ asset, report, reportDate }) => ({ asset, report, reportDate })),
      unmeasured: outcomes.length - measured.length,
    }),
  );
  return { ...result, ...collectionMonitoring(monitoring) };
}

/** The `property_ref` every PostHog manifest row carries: region and project. */
function posthogPropertyRef(settings: PosthogAssetSettings): string {
  return `${settings.host}:${settings.projectId}`;
}

/**
 * The earlier PostHog window ends owed a re-collection, per asset. A daily run
 * asks for the window ending yesterday, so a window end a run did not collect
 * would never be asked again. Owed: a window end whose latest attempt failed
 * for a network reason (asked again until PostHog answers); one whose latest
 * attempt PostHog answered "not now" (5xx, malformed, 429), asked once more
 * per kind, because the same answer twice is PostHog's settled answer; one the
 * dead uplink swallowed (named on the open `os-egress-down` flag); and one a
 * 429 stopped the run before asking (`stoppedRuns`). A refused key and a local
 * store failure are never re-asked. `assetAsks` decides which a run asks.
 */
async function owedWindows(
  env: IngestEnv,
  plans: readonly { candidate: Candidate; settings: PosthogAssetSettings }[],
): Promise<Map<string, OwedWindow[]>> {
  const owed = new Map<string, OwedWindow[]>();
  const add = (asset: string, report: string, end: string) => {
    const family = report as PosthogFamily;
    if (!POSTHOG_FAMILIES.includes(family)) return;
    const list = owed.get(asset) ?? [];
    list.push({ family, end });
    owed.set(asset, list);
  };
  const propertyRefs = new Map(plans.map(({ candidate, settings }) => [candidate.asset, posthogPropertyRef(settings)]));
  for (const row of await failedWindows(env.STORE)) {
    if (propertyRefs.get(row.asset) !== row.propertyRef) continue;
    const kind = transientRefusal(row.errorCode);
    const askOnceMore = kind !== null && row.codes.filter((code) => transientRefusal(code) === kind).length === 1;
    if (networkFailure(row.errorCode) || askOnceMore) add(row.asset, row.report, row.reportDate);
  }
  const entry = await openEgressLaneRecord(env, 'posthog');
  for (const [asset, parts] of Object.entries(entry?.parts ?? {})) {
    if (!propertyRefs.has(asset)) continue;
    for (const part of parts) {
      const dated = parseDatedArchivePart(part);
      if (dated?.integration === 'posthog') add(asset, dated.report, dated.reportDate);
    }
  }
  return owed;
}

/** The codes PostHog's 429 writes: its hourly bytes-read budget, or its request rate. */
const RATE_LIMITED_CODES: ReadonlySet<string> = new Set(['posthog_query_budget_exceeded', 'posthog_rate_limit']);

/**
 * A PostHog answer that means "not now" rather than "no", by kind. Null for
 * anything else.
 */
function transientRefusal(code: string | null): 'server' | 'malformed' | 'rate-limited' | null {
  if (code === null) return null;
  if (/^posthog_http_5\d\d$/.test(code)) return 'server';
  if (code === 'posthog_invalid_response') return 'malformed';
  if (RATE_LIMITED_CODES.has(code)) return 'rate-limited';
  return null;
}

interface FailedWindow {
  asset: string;
  propertyRef: string;
  report: string;
  reportDate: string;
  errorCode: string | null;
  /** Every failure code this window has had on this project, oldest first. */
  codes: string[];
}

/**
 * Every PostHog window end whose latest attempt failed in a way that may be
 * owed again, with its failure history; `owedWindows` decides. The WHERE only
 * narrows the scan to codes that could be owed. A window's failures come
 * oldest asked first.
 */
async function failedWindows(store: WorkspaceStore): Promise<FailedWindow[]> {
  const rows = await store.read((tx) =>
    tx.query<Omit<FailedWindow, 'codes'> & { codes: (string | null)[] }>(
      `SELECT e.asset_id AS asset, e.property_ref AS "propertyRef", e.report,
              e.report_date AS "reportDate", e.error_code AS "errorCode",
              ARRAY(SELECT o.error_code FROM noticeos.archive_runs o
                     WHERE o.workspace_id = e.workspace_id AND o.asset_id = e.asset_id
                       AND o.integration = 'posthog' AND o.report = e.report
                       AND o.report_date = e.report_date AND o.property_ref = e.property_ref
                       AND o.status = 'error'
                     ORDER BY o.requested_at, o.run_seq) AS codes
         FROM noticeos.archive_runs e
        WHERE e.integration = 'posthog'
          AND e.status = 'error'
          AND (e.error_code ILIKE '%timeout%' OR e.error_code ILIKE '%network%'
               OR e.error_code ILIKE '%request_failed%' OR e.error_code ILIKE '%unreachable%'
               OR e.error_code ~ '^posthog_http_5[0-9][0-9]$'
               OR e.error_code = ANY($1::text[]))
          AND NOT EXISTS (
            SELECT 1 FROM noticeos.archive_runs later
             WHERE later.workspace_id = e.workspace_id AND later.asset_id = e.asset_id
               AND later.integration = e.integration AND later.report = e.report
               AND later.report_date = e.report_date AND later.property_ref = e.property_ref
               AND later.requested_at > e.requested_at
          )`,
      [['posthog_invalid_response', ...RATE_LIMITED_CODES]],
    ),
  );
  return rows.map((row) => ({ ...row, codes: row.codes.filter((code): code is string => typeof code === 'string') }));
}

/**
 * The runs a PostHog 429 stopped, read back from the rows they left. Every stop
 * writes exactly one 429 row and every row of a run shares its `requested_at`,
 * so a 429 row's `requested_at` names a stopped run, and a family with no row
 * for the window that run would have asked is owed. Only for an asset already
 * being collected on its current project when the run was stopped (`since`).
 * The dates read are the three a run's window end can fall on.
 */
async function stoppedRuns(
  store: WorkspaceStore,
  plans: readonly { candidate: Candidate; settings: PosthogAssetSettings }[],
): Promise<StoppedRuns> {
  const stopped: StoppedRuns = { runs: [], assets: new Map() };
  const propertyRefs = new Map(plans.map(({ candidate, settings }) => [candidate.asset, posthogPropertyRef(settings)]));
  const assets = [...propertyRefs.keys()];
  // One read: the stopped runs, then what each asset recorded around them.
  const read = await store.read(async (tx) => {
    const runs = await tx.query<{ stoppedAt: string }>(
      `SELECT DISTINCT requested_at AS "stoppedAt" FROM noticeos.archive_runs
        WHERE integration = 'posthog' AND status = 'error'
          AND error_code = ANY($1::text[])
        ORDER BY requested_at`,
      [[...RATE_LIMITED_CODES]],
    );
    if (runs.length === 0) return null;
    const stoppedAt = runs.map((row) => javascriptInstant(row.stoppedAt));
    const dates = new Set<string>();
    for (const at of stoppedAt) {
      for (const shift of [-2, -1, 0]) dates.add(shiftCalendarDate(at.slice(0, 10), shift));
    }
    return {
      stoppedAt,
      firsts: await tx.query<{ asset: string; propertyRef: string; since: string }>(
        `SELECT asset_id AS asset, property_ref AS "propertyRef", min(requested_at) AS since
           FROM noticeos.archive_runs
          WHERE integration = 'posthog' AND asset_id = ANY($1::text[])
          GROUP BY asset_id, property_ref`,
        [assets],
      ),
      recorded: await tx.query<{ asset: string; propertyRef: string; report: string; reportDate: string }>(
        `SELECT DISTINCT asset_id AS asset, property_ref AS "propertyRef", report, report_date AS "reportDate"
           FROM noticeos.archive_runs
          WHERE integration = 'posthog'
            AND asset_id = ANY($1::text[])
            AND report_date = ANY($2::date[])`,
        [assets, [...dates]],
      ),
    };
  });
  if (read === null) return stopped;
  stopped.runs = read.stoppedAt;
  for (const row of read.firsts) {
    if (propertyRefs.get(row.asset) === row.propertyRef) {
      stopped.assets.set(row.asset, { since: javascriptInstant(row.since), recorded: new Set() });
    }
  }
  for (const row of read.recorded) {
    if (propertyRefs.get(row.asset) !== row.propertyRef) continue;
    stopped.assets.get(row.asset)?.recorded.add(`${row.report}\u0000${row.reportDate}`);
  }
  return stopped;
}

/** This asset's windows a 429-stopped run never asked, dated in its project's
 * calendar. */
function skippedByStop(run: AssetRun, projectTimeZone: string | null): OwedWindow[] {
  const history = run.state.retry.stopped.assets.get(run.target.asset);
  if (history === undefined) return [];
  const owed: OwedWindow[] = [];
  for (const stoppedAt of run.state.retry.stopped.runs) {
    if (stoppedAt < history.since) continue;
    for (const family of run.families) {
      const end = windowFor(family, projectTimeZone, undefined, Date.parse(stoppedAt)).end;
      if (!history.recorded.has(`${family}\u0000${end}`)) owed.push({ family, end });
    }
  }
  return owed;
}

/** Asset → key, out of the one map the resolver answered with. */
export function resolvePosthogKeys(rawMap: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  if (!rawMap || rawMap.trim().length === 0) return keys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMap);
  } catch {
    throw new SignalError('config_invalid', `${POSTHOG_KEY_SLOT} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SignalError('config_invalid', `${POSTHOG_KEY_SLOT} must be a JSON object of asset id to key.`);
  }
  for (const [asset, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SignalError('config_invalid', `${POSTHOG_KEY_SLOT}["${asset}"] must be a non-empty key.`);
    }
    keys.set(asset, value.trim());
  }
  return keys;
}

/** The launched, non-OS assets with a domain: the same membership rule as the
 * other per-asset provider archives. */
export async function posthogCandidates(store: WorkspaceStore): Promise<Candidate[]> {
  return store.read((tx) =>
    tx.query<{ asset: string; domain: string }>(
      `SELECT asset_id AS asset, domain
         FROM noticeos.assets
        WHERE NOT is_os
          AND status NOT IN ('pre-launch','retired')
          AND domain IS NOT NULL
        ORDER BY ${SITE_ORDER}`,
    ),
  );
}

// One run per asset at a time. PostHog meters queries per project, so two runs
// over the same asset at once spend the hour's budget twice. Every run takes
// the asset's lease before its first PostHog request and gives it back on
// every exit; a run that finds it held records an `in-flight` skip. The lease
// is a row in `noticeos.integration_leases` (`posthog:<asset>`) rather than a
// module variable: a row holds across isolates and a runtime restart. It
// carries its own end, so a crash costs at most one lease length, and release
// deletes the row only when this run still owns it.

/** The `lease_key` of one asset's PostHog lease. */
export function posthogLeaseKey(asset: string): string {
  return `${POSTHOG_LANE_ID}:${asset}`;
}

type PosthogLeaseClaim =
  | { owner: string; heldBy: null }
  | { owner: null; heldBy: PosthogRunInFlight };

/** Take the asset's lease, or say who holds it. One upsert: Postgres locks the
 * row, so of two runs that ask together exactly one gets a change. */
export async function claimPosthogLease(
  store: WorkspaceStore,
  asset: string,
  nowMs: number,
): Promise<PosthogLeaseClaim> {
  const key = posthogLeaseKey(asset);
  const owner = crypto.randomUUID();
  // Twice at most: a holder that releases between our upsert and our read
  // leaves no row to report, and the second upsert then takes the lease.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claimed = await claimLease(store, { key, owner, nowMs, expiresAtMs: nowMs + POSTHOG_LEASE_MS });
    if (claimed) return { owner, heldBy: null };
    const [held] = await store.read((tx) =>
      tx.query<{ expires_at: string }>('SELECT expires_at FROM noticeos.integration_leases WHERE lease_key = $1', [key]),
    );
    const expiresAtMs = held === undefined ? null : Date.parse(javascriptInstant(held.expires_at));
    if (expiresAtMs !== null && expiresAtMs > nowMs) {
      return { owner: null, heldBy: runInFlight(expiresAtMs, nowMs) };
    }
  }
  // Refuse rather than risk a second concurrent run.
  return { owner: null, heldBy: runInFlight(nowMs + POSTHOG_LEASE_MS, nowMs) };
}

/** Give the lease back if this run still holds it. Never throws: a refused
 * release must not fail a finished run, and the lease runs out on its own. */
export async function releasePosthogLease(store: WorkspaceStore, asset: string, owner: string): Promise<void> {
  try {
    await store.write((tx) =>
      tx.execute('DELETE FROM noticeos.integration_leases WHERE lease_key = $1 AND owner = $2', [posthogLeaseKey(asset), owner]),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'posthog_lease_release_failed',
        asset,
        errorCode: normalizeSignalError(error, 'The PostHog lease could not be released.').code,
        leaseMinutes: POSTHOG_LEASE_MS / 60_000,
      }),
    );
  }
}

/** The lease stores only its end; it is never renewed, so its start is one
 * lease length earlier. */
function runInFlight(expiresAtMs: number, nowMs: number): PosthogRunInFlight {
  const startedAtMs = expiresAtMs - POSTHOG_LEASE_MS;
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    runningSeconds: Math.max(0, Math.round((nowMs - startedAtMs) / 1000)),
    leaseExpiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * The refusal as one line, for whoever fired the second run. Fits the first
 * 400 characters `pnpm signals:collect` prints.
 */
export function posthogInFlightDetail(asset: string, inFlight: PosthogRunInFlight): string {
  return (
    `Already running for ${asset} · started ${inFlight.runningSeconds}s ago · nothing asked · ` +
    `free at ${inFlight.leaseExpiresAt}`
  );
}

interface AssetRun {
  target: PosthogTarget;
  key: string;
  settings: PosthogAssetSettings;
  families: PosthogFamily[];
  window: PosthogWindow | undefined;
  nowMs: number;
  requestedAt: string;
  egress: EgressLane;
  monitoring: CollectionMonitoring;
  state: RunState;
  skipped: PosthogSkip[];
}

/** One request this run makes for an asset: today's window, or an earlier one
 * an outage cost (`owed`). */
interface Ask {
  family: PosthogFamily;
  window: PosthogWindow;
  owed: boolean;
}

async function collectAsset(env: IngestEnv, run: AssetRun): Promise<SignalDumpOutcome[]> {
  const { target, key, settings, families, nowMs, requestedAt, egress, monitoring, state, skipped } = run;
  const outcomes: SignalDumpOutcome[] = [];
  const origin = HOST_ORIGIN[settings.host];

  // The project read: its timezone decides every window's dates, and a key
  // that cannot read the project fails here for every family at once.
  let projectTimeZone: string | null;
  try {
    projectTimeZone = await readProjectTimeZone(origin, settings.projectId, key, egress.transport.fetch, state);
  } catch (error) {
    // The OS's own uplink, not PostHog: every family goes unmeasured and is
    // named on the run's `os-egress-down` flag, so the next run asks again.
    if (await egressExplains(egress.gate, egress.transport, error)) {
      state.retry.open = false;
      for (const family of families) {
        outcomes.push(unmeasuredDumpOutcome(egress.gate, target, family, windowFor(family, null, run.window, nowMs).end));
      }
      return outcomes;
    }
    const normalized = asPosthogError(error, 'PostHog project read failed.');
    // A 429 is "not now", recorded against the first family with the rest
    // skipped. Anything else is today's answer for every family this asset was
    // due, so each gets the same failure row and none is asked.
    const refused = state.stop !== null ? families.slice(0, 1) : families;
    for (const family of refused) {
      outcomes.push(await failFamily(env, run, family, windowFor(family, null, run.window, nowMs), normalized));
    }
    for (const family of families.slice(refused.length)) {
      skipped.push({ asset: target.asset, family, ...state.stop! });
    }
    return outcomes;
  }

  const asks = assetAsks(run, projectTimeZone);
  for (const [index, ask] of asks.entries()) {
    // A 429 stops the whole run, a re-collection included: today's unasked
    // windows are named as skipped, and an owed one stays owed.
    if (state.stop !== null) {
      for (const rest of asks.slice(index)) {
        if (!rest.owed) skipped.push({ asset: target.asset, family: rest.family, ...state.stop });
      }
      break;
    }
    // An earlier window is asked only while this run has not seen the
    // connection fail.
    if (ask.owed && !state.retry.open) continue;
    const outcome = await collectFamily(env, {
      target,
      key,
      settings,
      family: ask.family,
      window: ask.window,
      projectTimeZone,
      origin,
      requestedAt,
      egress,
      monitoring,
      state,
    });
    outcomes.push(outcome);
    if (ask.owed) {
      state.retry.asked += 1;
      state.retry.outcomes.push(outcome);
    }
    // A connection that is down, or PostHog's servers failing a re-ask, stops
    // the re-collection after one ask: the rest stay owed for the next run.
    const serverFailed = transientRefusal(outcome.errorCode) === 'server';
    if (outcome.egressDown || (ask.owed && (networkFailure(outcome.errorCode) || serverFailed))) state.retry.open = false;
    // The uplink went mid-asset: today's remaining windows are unmeasured and
    // owed on the flag, without asking into the same wall.
    if (outcome.egressDown) {
      for (const rest of asks.slice(index + 1)) {
        if (!rest.owed) outcomes.push(unmeasuredDumpOutcome(egress.gate, target, rest.family, rest.window.end));
      }
      break;
    }
    // A key PostHog refuses for one query is refused for all of them: the rest
    // of today's windows carry the same failure without asking again.
    if (outcome.status === 'error' && outcome.errorCode === ACCESS_DENIED) {
      const error = new SignalError(ACCESS_DENIED, 'Not asked · PostHog refused the key earlier in this run');
      for (const rest of asks.slice(index + 1)) {
        if (!rest.owed) outcomes.push(await failFamily(env, run, rest.family, rest.window, error));
      }
      break;
    }
  }
  return outcomes;
}

/**
 * This asset's requests, in order: per family, the earlier window ends it is
 * owed (oldest first, at most `POSTHOG_RETRY_LIMIT` a run, and only ends older
 * than today's), then today's window. Today's window is each family's last
 * request so its row is the family's newest, which the Tower reads as its
 * current window.
 */
function assetAsks(run: AssetRun, projectTimeZone: string | null): Ask[] {
  const today = new Map(run.families.map((family) => [family, windowFor(family, projectTimeZone, run.window, run.nowMs)]));
  const owed = new Map<string, OwedWindow>();
  if (run.window === undefined) {
    for (const item of [...(run.state.retry.owed.get(run.target.asset) ?? []), ...skippedByStop(run, projectTimeZone)]) {
      const end = today.get(item.family)?.end;
      if (end !== undefined && item.end < end) owed.set(`${item.family}\u0000${item.end}`, item);
    }
  }
  const ordered = [...owed.values()].sort(
    (a, b) => a.end.localeCompare(b.end) || POSTHOG_FAMILIES.indexOf(a.family) - POSTHOG_FAMILIES.indexOf(b.family),
  );
  run.state.retry.found += ordered.length;
  const chosen = ordered.slice(0, run.state.retry.limit);
  return run.families.flatMap((family): Ask[] => [
    ...chosen
      .filter((item) => item.family === family)
      .map((item) => ({ family, window: windowEnding(family, item.end), owed: true })),
    { family, window: today.get(family)!, owed: false },
  ]);
}

function failFamily(
  env: IngestEnv,
  run: AssetRun,
  family: PosthogFamily,
  window: PosthogWindow,
  error: SignalError,
): Promise<SignalDumpOutcome> {
  return archiveDumpFailure(env.STORE, {
    monitoring: run.monitoring,
    target: run.target,
    report: family,
    reportDate: window.end,
    requestedAt: run.requestedAt,
    dataState: 'provider-snapshot',
    error,
  });
}

/** Any thrown value as a PostHog-coded failure. A store failure while archiving
 * arrives as `local_store_failed` from `archiveCollectedDump`, never here. */
function asPosthogError(error: unknown, fallback: string): SignalError {
  if (error instanceof SignalError) return error;
  const base = normalizeSignalError(error, fallback);
  return new SignalError(base.code === 'request_timeout' ? 'posthog_timeout' : 'posthog_request_failed', base.message);
}

/**
 * The inclusive window a family covers, in the project's own calendar: a daily
 * run ends yesterday there and reaches back the family's trailing length; an
 * explicit window is used as given. With no timezone the dates are UTC.
 */
export function windowFor(
  family: PosthogFamily,
  projectTimeZone: string | null,
  explicit: PosthogWindow | undefined,
  nowMs: number,
): PosthogWindow {
  if (explicit) return explicit;
  const zone = projectTimeZone !== null && isValidTimeZone(projectTimeZone) ? projectTimeZone : 'UTC';
  return windowEnding(family, shiftCalendarDate(dateInTimeZone(nowMs, zone), -1));
}

/** The family's trailing window that ends on `end`, inclusive — the same
 * window a daily run on the day after `end` asked for. */
export function windowEnding(family: PosthogFamily, end: string): PosthogWindow {
  return { start: shiftCalendarDate(end, -(POSTHOG_WINDOW_DAYS[family] - 1)), end };
}

interface FamilyRun {
  target: PosthogTarget;
  key: string;
  settings: PosthogAssetSettings;
  family: PosthogFamily;
  window: PosthogWindow;
  projectTimeZone: string | null;
  origin: string;
  requestedAt: string;
  egress: EgressLane;
  monitoring: CollectionMonitoring;
  state: RunState;
}

const ACCESS_DENIED = 'posthog_access_denied';

/** The name a HogQL query carries in PostHog's own query log: which product
 * ran it, namespaced like every other product key (`noticeos:…`), and for
 * which family. */
export function posthogQueryName(family: string): string {
  return `noticeos:posthog-${family}`;
}

async function collectFamily(env: IngestEnv, run: FamilyRun): Promise<SignalDumpOutcome> {
  const { target, key, settings, family, window, projectTimeZone, origin, requestedAt, egress, monitoring, state } = run;
  const rowLimit = family === 'funnels' ? funnelStepCount(settings.funnels) : POSTHOG_ROW_LIMITS[family];
  try {
    const query = posthogQuery(family, window, settings.funnels);
    const endpoint = `${origin}/api/projects/${settings.projectId}/query/`;
    const response = await egress.transport.fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: query.text }, name: posthogQueryName(family) }),
      signal: AbortSignal.timeout(POSTHOG_REQUEST_TIMEOUT_MS),
    });
    readBudget(response, state);
    const payload = await boundedResponseJson(response, 'PostHog', RESPONSE_BYTE_LIMIT, POSTHOG_RESPONSE);
    if (!response.ok) throw posthogProviderError(response.status, payload, state);

    const results = queryResults(payload, query.columns);
    const { rows, truncated } = parseFamilyRows(family, results, settings.funnels);
    const body: PosthogArchiveBody = {
      provider: 'posthog',
      family,
      asset: target.asset,
      host: settings.host,
      projectId: settings.projectId,
      projectTimeZone,
      window,
      collectedAt: requestedAt,
      rowLimit,
      truncated,
      rows,
    } as PosthogArchiveBody;
    const checked = posthogArchiveBodySchema.safeParse(body);
    if (!checked.success) {
      throw new SignalError(
        'posthog_invalid_response',
        `PostHog ${family} rows did not match the archive contract: ${checked.error.issues[0]?.message ?? 'invalid'}`.slice(0, 500),
      );
    }
    const request = { endpoint, family, host: settings.host, projectId: settings.projectId, window, rowLimit, query: { kind: 'HogQLQuery', query: query.text } };
    const page: DumpPage = { request, response: body };
    // The body's own `collectedAt` changes on every call; the hash reads the
    // page without it so a settled window re-archives as `unchanged`.
    const { collectedAt: _collectedAt, ...stable } = body;
    return await archiveCollectedDump(env, {
      monitoring,
      provider: 'posthog',
      target,
      report: family,
      reportDate: window.end,
      requestedAt,
      dataState: 'provider-snapshot',
      collected: {
        pages: [page],
        canonicalPages: [{ request, response: stable }],
        providerRows: rows.length,
        providerTruncated: truncated,
      },
    });
  } catch (error) {
    // The uplink can also die after the project read.
    if (await egressExplains(egress.gate, egress.transport, error)) {
      return unmeasuredDumpOutcome(egress.gate, target, family, window.end);
    }
    const normalized = asPosthogError(error, `PostHog ${family} query failed.`);
    return archiveDumpFailure(env.STORE, {
      monitoring,
      target,
      report: family,
      reportDate: window.end,
      requestedAt,
      dataState: 'provider-snapshot',
      error: normalized,
    });
  }
}

function funnelStepCount(funnels: readonly PosthogFunnel[]): number {
  return funnels.reduce((sum, funnel) => sum + funnel.steps.length, 0);
}

async function readProjectTimeZone(
  origin: string,
  projectId: string,
  key: string,
  fetchImpl: typeof fetch,
  state: RunState,
): Promise<string | null> {
  const response = await fetchImpl(`${origin}/api/projects/${projectId}/`, {
    method: 'GET',
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(POSTHOG_REQUEST_TIMEOUT_MS),
  });
  const payload = await boundedResponseJson(response, 'PostHog', RESPONSE_BYTE_LIMIT, POSTHOG_RESPONSE);
  if (!response.ok) {
    if (response.status === 404) {
      throw new SignalError(
        'posthog_mapping_project_not_found',
        `PostHog has no project ${projectId} in this region, or this key cannot see it (HTTP 404).`,
      );
    }
    throw posthogProviderError(response.status, payload, state);
  }
  const zone = asRecord(payload)?.timezone;
  return typeof zone === 'string' && zone.length > 0 ? zone : null;
}

function readBudget(response: Response, state: RunState): void {
  const remaining = Number(response.headers.get(BUDGET_HEADER));
  if (response.headers.has(BUDGET_HEADER) && Number.isFinite(remaining)) state.budgetRemainingBytes = remaining;
  const read = Number(response.headers.get(BYTES_READ_HEADER));
  if (response.headers.has(BYTES_READ_HEADER) && Number.isFinite(read)) state.bytesRead += read;
  // Nothing left means the next query would be refused: stop before asking.
  if (response.ok && state.budgetRemainingBytes !== null && state.budgetRemainingBytes <= 0 && state.stop === null) {
    state.stop = { reason: 'budget-exhausted', detail: 'PostHog reported no query budget left this hour.' };
  }
}

/** One provider refusal, with the codes the health classifier reads: `access`
 * for a key PostHog will not accept, `budget` for the hourly bytes-read
 * allowance, `rate-limit` for request-rate limits. A 429 also stops the run. */
function posthogProviderError(status: number, payload: unknown, state: RunState): SignalError {
  const record = asRecord(payload);
  const detail =
    stringField(record, 'detail') ?? stringField(record, 'error') ?? `PostHog returned HTTP ${status}.`;
  if (status === 401 || status === 403) {
    // The refusal and its status, then PostHog's own words.
    return new SignalError(ACCESS_DENIED, `PostHog refused the key · HTTP ${status} · ${detail}`.slice(0, 500));
  }
  if (status === 429) {
    const budget = stringField(record, 'code') === 'api_queries_budget_exceeded';
    state.stop = budget
      ? { reason: 'budget-exhausted', detail: 'PostHog’s hourly query budget is used up; the rest of this run was not asked.' }
      : { reason: 'rate-limited', detail: 'PostHog is limiting query requests; the rest of this run was not asked.' };
    return new SignalError(
      budget ? 'posthog_query_budget_exceeded' : 'posthog_rate_limit',
      `PostHog refused the query (HTTP 429${budget ? ', hourly query budget used up' : ', request rate limit'}). ${detail}`.slice(0, 500),
    );
  }
  return new SignalError(`posthog_http_${status}`, detail.slice(0, 500));
}

/** The answer's rows, checked against the columns the query named. */
function queryResults(payload: unknown, columns: readonly string[]): unknown[][] {
  const record = asRecord(payload);
  if (record === null) throw new SignalError('posthog_invalid_response', 'PostHog returned no query result.');
  const status = asRecord(record.query_status);
  if (status !== null && status.complete !== true) {
    throw new SignalError('posthog_incomplete_query', 'PostHog answered before the query finished.');
  }
  const results = record.results;
  if (!Array.isArray(results) || !results.every(Array.isArray)) {
    throw new SignalError('posthog_invalid_response', 'PostHog returned no result rows.');
  }
  const named = record.columns;
  if (Array.isArray(named) && (named.length !== columns.length || named.some((name, i) => name !== columns[i]))) {
    throw new SignalError(
      'posthog_invalid_response',
      `PostHog returned columns ${JSON.stringify(named)}; expected ${JSON.stringify(columns)}.`.slice(0, 500),
    );
  }
  for (const row of results as unknown[][]) {
    if (row.length !== columns.length) {
      throw new SignalError('posthog_invalid_response', `PostHog returned a row of ${row.length} values; expected ${columns.length}.`);
    }
  }
  return results as unknown[][];
}

// ---------------------------------------------------------------------------
// The six queries. Every one reads `events` inside its window, aggregates
// server-side and ends in an explicit LIMIT. PostHog interprets timestamps in
// the project's timezone, so `toDate(timestamp)` is a project-local day.
// ---------------------------------------------------------------------------

export interface PosthogQuery {
  text: string;
  columns: readonly string[];
}

/** A HogQL string literal. Values are already validated upstream; escaping is
 * the second lock. */
export function hogqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function timeBounds(window: PosthogWindow): string {
  const after = shiftCalendarDate(window.end, 1);
  return (
    `timestamp >= toDateTime(${hogqlString(`${window.start} 00:00:00`)}) ` +
    `AND timestamp < toDateTime(${hogqlString(`${after} 00:00:00`)})`
  );
}

export function posthogQuery(
  family: PosthogFamily,
  window: PosthogWindow,
  funnels: readonly PosthogFunnel[] = [],
): PosthogQuery {
  const bounds = timeBounds(window);
  const limit = POSTHOG_ROW_LIMITS[family] + 1;
  switch (family) {
    case 'web-daily':
      return {
        columns: ['date', 'pageviews', 'people', 'sessions'],
        text: [
          'SELECT',
          '  toString(toDate(timestamp)) AS date,',
          '  count() AS pageviews,',
          '  uniq(person_id) AS people,',
          "  uniq(nullIf(toString(properties.$session_id), '')) AS sessions",
          'FROM events',
          `WHERE event = '$pageview' AND ${bounds}`,
          'GROUP BY date',
          'ORDER BY date ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'events':
      return {
        columns: ['event', 'count', 'people', 'first_seen', 'last_seen'],
        text: [
          'SELECT',
          '  event,',
          '  count() AS count,',
          '  uniq(person_id) AS people,',
          '  toString(min(toDate(timestamp))) AS first_seen,',
          '  toString(max(toDate(timestamp))) AS last_seen',
          'FROM events',
          `WHERE ${bounds}`,
          'GROUP BY event',
          'ORDER BY count DESC, event ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'exceptions':
      return {
        columns: [
          'exception_type',
          'exception_message',
          'occurrences',
          'people',
          'sessions',
          'max_per_session',
          'has_source_file',
          'top_path',
          'top_browser',
        ],
        text: [
          'SELECT',
          '  exception_type,',
          '  exception_message,',
          '  count() AS occurrences,',
          '  uniq(person_id) AS people,',
          '  uniq(session_id) AS sessions,',
          '  max(session_occurrences) AS max_per_session,',
          '  max(source_file) AS has_source_file,',
          "  argMax(path, tuple(path_occurrences, coalesce(path, ''))) AS top_path,",
          "  argMax(browser, tuple(browser_occurrences, coalesce(browser, ''))) AS top_browser",
          'FROM (',
          '  SELECT',
          '    exception_type, exception_message, person_id, session_id, path, browser, source_file,',
          '    if(session_id IS NULL, 1, count() OVER (PARTITION BY exception_type, exception_message, session_id)) AS session_occurrences,',
          '    count() OVER (PARTITION BY exception_type, exception_message, path) AS path_occurrences,',
          '    count() OVER (PARTITION BY exception_type, exception_message, browser) AS browser_occurrences',
          '  FROM (',
          '    SELECT',
          "      nullIf(if(JSONExtractString(properties, '$exception_list', 1, 'type') != '', JSONExtractString(properties, '$exception_list', 1, 'type'), JSONExtractString(properties, '$exception_type')), '') AS exception_type,",
          `      nullIf(substring(if(JSONExtractString(properties, '$exception_list', 1, 'value') != '', JSONExtractString(properties, '$exception_list', 1, 'value'), JSONExtractString(properties, '$exception_message')), 1, ${POSTHOG_MESSAGE_MAX}), '') AS exception_message,`,
          '      person_id,',
          "      nullIf(toString(properties.$session_id), '') AS session_id,",
          "      nullIf(toString(properties.$pathname), '') AS path,",
          "      nullIf(toString(properties.$browser), '') AS browser,",
          `      if(match(JSONExtractRaw(properties, '$exception_list'), '"(filename|abs_path)": *"[^"]+"'), 1, 0) AS source_file`,
          '    FROM events',
          `    WHERE event = '$exception' AND ${bounds}`,
          '  )',
          ')',
          'GROUP BY exception_type, exception_message',
          'ORDER BY occurrences DESC, people DESC, exception_type ASC, exception_message ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'rageclicks':
      return {
        columns: [
          'path',
          'tag',
          'text',
          'attr',
          'clicks',
          'people',
          'desktop_clicks',
          'mobile_clicks',
          'tablet_clicks',
          'page_people',
        ],
        text: [
          'SELECT',
          '  rc.path AS path, rc.tag AS tag, rc.text AS text, rc.attr AS attr,',
          '  rc.clicks AS clicks, rc.people AS people,',
          '  rc.desktop_clicks AS desktop_clicks, rc.mobile_clicks AS mobile_clicks, rc.tablet_clicks AS tablet_clicks,',
          '  coalesce(pv.page_people, 0) AS page_people',
          'FROM (',
          '  SELECT',
          '    path, tag, text, attr,',
          '    count() AS clicks,',
          '    uniq(person_id) AS people,',
          "    countIf(device = 'Desktop') AS desktop_clicks,",
          "    countIf(device = 'Mobile') AS mobile_clicks,",
          "    countIf(device = 'Tablet') AS tablet_clicks",
          '  FROM (',
          '    SELECT',
          '      path, person_id, device,',
          "      nullIf(extract(target, '^([A-Za-z0-9_-]+)'), '') AS tag,",
          `      nullIf(substring(extract(target, 'text="([^"]*)"'), 1, ${POSTHOG_ELEMENT_TEXT_MAX}), '') AS text,`,
          "      coalesce(nullIf(extract(target, 'attr__name=\"([^\"]*)\"'), ''), nullIf(extract(target, 'attr__id=\"([^\"]*)\"'), '')) AS attr",
          '    FROM (',
          '      SELECT',
          "        nullIf(toString(properties.$pathname), '') AS path,",
          '        person_id,',
          "        nullIf(toString(properties.$device_type), '') AS device,",
          "        splitByChar(';', elements_chain)[1] AS target",
          '      FROM events',
          `      WHERE event = '$rageclick' AND ${bounds}`,
          '    )',
          '  )',
          '  GROUP BY path, tag, text, attr',
          ') AS rc',
          'LEFT JOIN (',
          "  SELECT nullIf(toString(properties.$pathname), '') AS path, uniq(person_id) AS page_people",
          '  FROM events',
          `  WHERE event = '$pageview' AND ${bounds}`,
          '  GROUP BY path',
          ') AS pv ON rc.path = pv.path',
          'ORDER BY people DESC, clicks DESC, path ASC, tag ASC, text ASC, attr ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'web-vitals':
      return {
        columns: ['path', 'device', 'os', 'lcp_p75', 'inp_p75', 'cls_p75', 'fcp_p75', 'measurements'],
        text: [
          'SELECT',
          "  nullIf(toString(properties.$pathname), '') AS path,",
          "  nullIf(toString(properties.$device_type), '') AS device,",
          "  nullIf(toString(properties.$os), '') AS os,",
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_LCP_value)) AS lcp_p75,',
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_INP_value)) AS inp_p75,',
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_CLS_value)) AS cls_p75,',
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_FCP_value)) AS fcp_p75,',
          '  count() AS measurements',
          'FROM events',
          `WHERE event = '$web_vitals' AND ${bounds}`,
          "  AND nullIf(toString(properties.$pathname), '') IN (",
          "    SELECT nullIf(toString(properties.$pathname), '') AS top_path",
          '    FROM events',
          `    WHERE event = '$web_vitals' AND ${bounds}`,
          '    GROUP BY top_path',
          '    ORDER BY count() DESC, top_path ASC',
          `    LIMIT ${POSTHOG_WEB_VITALS_TOP_PATHS}`,
          '  )',
          'GROUP BY path, device, os',
          'ORDER BY measurements DESC, path ASC, device ASC, os ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'funnels':
      return funnelQuery(window, funnels);
  }
}

/**
 * Every declared funnel in ONE query: per person, `windowFunnel` over the whole
 * window reports the furthest step reached IN ORDER; the outer select counts the
 * people at or past each step. One row comes back, one column per step.
 */
function funnelQuery(window: PosthogWindow, funnels: readonly PosthogFunnel[]): PosthogQuery {
  const days = Math.round(
    (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86_400_000,
  ) + 1;
  const seconds = days * 86_400;
  const events = [...new Set(funnels.flatMap((funnel) => funnel.steps.map((step) => step.event)))].sort();
  const columns: string[] = [];
  const counts: string[] = [];
  const levels: string[] = [];
  funnels.forEach((funnel, f) => {
    const conditions = funnel.steps.map((step) =>
      step.path === undefined
        ? `event = ${hogqlString(step.event)}`
        : `event = ${hogqlString(step.event)} AND toString(properties.$pathname) = ${hogqlString(step.path)}`,
    );
    levels.push(`  windowFunnel(${seconds})(toDateTime(timestamp), ${conditions.join(', ')}) AS funnel_${f + 1}`);
    funnel.steps.forEach((_step, s) => {
      const column = `funnel_${f + 1}_step_${s + 1}`;
      columns.push(column);
      counts.push(`  countIf(funnel_${f + 1} >= ${s + 1}) AS ${column}`);
    });
  });
  return {
    columns,
    text: [
      'SELECT',
      counts.join(',\n'),
      'FROM (',
      '  SELECT',
      '  person_id,',
      levels.join(',\n'),
      '  FROM events',
      `  WHERE ${timeBounds(window)}`,
      `    AND event IN (${events.map(hogqlString).join(', ')})`,
      '  GROUP BY person_id',
      ')',
      'LIMIT 1',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Rows, as the contract names them.
// ---------------------------------------------------------------------------

type AnyRow = PosthogArchiveBody['rows'][number];

export function parseFamilyRows(
  family: PosthogFamily,
  results: unknown[][],
  funnels: readonly PosthogFunnel[] = [],
): { rows: AnyRow[]; truncated: boolean } {
  if (family === 'funnels') {
    const [only] = results;
    const rows: AnyRow[] = [];
    let column = 0;
    for (const funnel of funnels) {
      funnel.steps.forEach((step, index) => {
        rows.push({
          funnelId: funnel.id,
          name: funnel.name,
          step: index + 1,
          event: step.event,
          path: step.path ?? null,
          // No person matched any step event: a counted zero, not a gap.
          people: only === undefined ? 0 : count(only[column]),
        });
        column += 1;
      });
    }
    return { rows, truncated: false };
  }
  const bound = POSTHOG_ROW_LIMITS[family];
  const truncated = results.length > bound;
  const kept = results.slice(0, bound);
  return { rows: kept.map((row) => parseRow(family, row)), truncated };
}

function parseRow(family: Exclude<PosthogFamily, 'funnels'>, row: unknown[]): AnyRow {
  switch (family) {
    case 'web-daily':
      return { date: day(row[0]), pageviews: count(row[1]), people: count(row[2]), sessions: count(row[3]) };
    case 'events':
      return { event: requiredText(row[0], 'event'), count: count(row[1]), people: count(row[2]), firstSeen: day(row[3]), lastSeen: day(row[4]) };
    case 'exceptions':
      return {
        type: text(row[0]),
        message: clip(text(row[1]), POSTHOG_MESSAGE_MAX),
        count: count(row[2]),
        people: count(row[3]),
        sessions: count(row[4]),
        maxPerSession: count(row[5]),
        hasSourceFile: count(row[6]) > 0,
        topPath: text(row[7]),
        topBrowser: text(row[8]),
      };
    case 'rageclicks':
      return {
        path: text(row[0]),
        tag: text(row[1]),
        text: clip(text(row[2]), POSTHOG_ELEMENT_TEXT_MAX),
        attr: text(row[3]),
        clicks: count(row[4]),
        people: count(row[5]),
        desktopClicks: count(row[6]),
        mobileClicks: count(row[7]),
        tabletClicks: count(row[8]),
        pagePeople: count(row[9]),
      };
    case 'web-vitals':
      return {
        path: text(row[0]),
        device: text(row[1]),
        os: text(row[2]),
        lcpP75: measure(row[3]),
        inpP75: measure(row[4]),
        clsP75: measure(row[5]),
        fcpP75: measure(row[6]),
        measurements: count(row[7]),
      };
  }
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SignalError('posthog_invalid_response', `PostHog returned ${JSON.stringify(value)} where a count belongs.`);
  }
  return parsed;
}

function measure(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) throw new SignalError('posthog_invalid_response', `PostHog returned a negative measurement ${parsed}.`);
  // Three decimals: a layout-shift score needs them, and milliseconds lose nothing.
  return Math.round(parsed * 1000) / 1000;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

function requiredText(value: unknown, name: string): string {
  const s = text(value);
  if (s === null) throw new SignalError('posthog_invalid_response', `PostHog returned a row with no ${name}.`);
  return s;
}

/** At most `max` characters, never a split surrogate pair. */
function clip(value: string | null, max: number): string | null {
  if (value === null) return null;
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

function day(value: unknown): string {
  const s = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new SignalError('posthog_invalid_response', `PostHog returned ${JSON.stringify(value)} where a date belongs.`);
  }
  return s;
}
