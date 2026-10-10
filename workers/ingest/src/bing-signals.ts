import { tryHealthConnection } from './integration-health-context.js';
import { beginCollection, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
// Operator-owned Bing Webmaster Tools collector.
//
// One user-level API key covers every verified site. The collector discovers
// those sites from Bing, intersects them with every non-retired portfolio
// property (including Sense-only pre-launch properties), and writes daily
// clicks/impressions to the same append-only signal ledger as GSC.
// Bing refreshes this dataset daily, so this runs on the nightly pull tick.

import {
  normalizeSignalError,
  recordSignalFailure,
  recordSignalSuccess,
  LIVE_SIGNAL_WINDOW_DAYS,
  SignalError,
  type SignalDateWindow,
  type SignalObservation,
  type SignalProviderResult,
} from './signal-store.js';
import type { CredentialSource } from '@noticeos/contract';
import {
  BING_CREDENTIAL_REF,
  bingRequest,
  bingResponseRows,
  bingSiteMapping,
  bingTarget,
  getBingVerifiedSites,
  loadBingPortfolioCandidates,
  parseBingDate,
  type BingWebmasterTarget,
} from './bing-client.js';
import {
  type LaneMappingSource,
  type LaneRegister,
  laneDeclined,
  mappingSourceTally,
} from './lane-mapping.js';
import {
  credentialConnected,
  recordCredentialOutcome,
  resolveCredential,
  sourcedCredentialRef,
} from './credentials.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import {
  EGRESS_DOWN_CODE,
  EGRESS_NOT_ASKED,
  EgressGate,
  type EgressRunOutcome,
  egressExplains,
  watchTransport,
} from './egress.js';

export interface BingSignalOutcome {
  asset: string;
  integration: 'bing-webmaster';
  status: 'success' | 'error';
  providerRows: number;
  observationCount: number;
  errorCode: string | null;
  /** Which mapping named the site this attempt asked for: the asset's own
   * register entry, or the domain match. */
  mappingSource: LaneMappingSource;
  /** True when the OS's own uplink, not Bing, is why this property went
   * uncollected: still a failure, but no `signal_runs` row and no Health
   * observation accuse the property or Bing. */
  egressDown?: true;
}

export interface BingSignalsResult {
  attempted: number;
  succeeded: number;
  failed: number;
  outcomes: BingSignalOutcome[];
  /** What the run's egress gate concluded — see {@link EgressRunOutcome}. */
  egress: EgressRunOutcome;
}

export interface BingSignalsOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  /** Override the compiled-in config/integrations.json mapping (tests state
   * their own register instead of editing the operator's file). */
  laneRegister?: LaneRegister;
  /** Where this run's config came from, per file, reported on the completion line. */
  configSources?: ConfigSourceMap;
  /** Override the run's egress gate (tests control the verdict TTL); every other
   * caller gets a real one over the same fetcher. */
  egress?: EgressGate;
  /** Only these assets, instead of every portfolio candidate. The membership
   * rule is unchanged: an asset the nightly run would not collect is not
   * collected here either. */
  assets?: readonly string[];
}

export async function runBingSignals(
  env: IngestEnv,
  options: BingSignalsOptions = {},
): Promise<BingSignalsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  // The whole run hangs off one discovery call, so a dead uplink must not
  // become a `request_failed` row on every property. The gate is asked only
  // about a Bing call that came back with no status; its beacons use the raw
  // fetcher.
  const gate = options.egress ?? new EgressGate(env, { lane: 'bing-signals', fetchImpl, at: new Date(nowMs).toISOString() });
  const transport = watchTransport(fetchImpl);
  const bingFetch = transport.fetch;
  const scope = options.assets === undefined ? null : new Set(options.assets);
  // A site its Data sources row declines is not asked for at all; the domain
  // match below would otherwise still find it.
  const candidates = (await loadBingPortfolioCandidates(env.STORE))
    .filter((candidate) => scope === null || scope.has(candidate.asset))
    .filter((candidate) => !laneDeclined(candidate.asset, 'bing-webmaster', options.laneRegister));
  const requestedWindow = collectionWindow(nowMs);
  const outcomes: BingSignalOutcome[] = [];
  // Store first, legacy env binding second. A caller that passed a key
  // explicitly is a test: it is `env` by definition, because nothing resolved it.
  const resolved = await resolveCredential(env, 'bing-webmaster');
  const health = await tryHealthConnection(env, 'bing-webmaster', resolved);
  const monitoring = beginCollection(env.STORE, health);
  const apiKey = options.apiKey ?? resolved.fields[BING_CREDENTIAL_REF];
  const source: CredentialSource = options.apiKey === undefined ? resolved.source : 'env';
  const ref = sourcedCredentialRef(BING_CREDENTIAL_REF, source);

  // Bing not connected at all is no work, not a failure. A stored key this
  // Worker cannot open is still connected, and still fails below.
  if (!apiKey && options.apiKey === undefined && !(await credentialConnected(env, 'bing-webmaster', resolved))) {
    console.log(JSON.stringify({ event: 'bing_signals_not_connected' }));
    return { attempted: 0, succeeded: 0, failed: 0, outcomes: [], egress: EGRESS_NOT_ASKED };
  }

  let sites: Map<string, string>;
  try {
    if (!apiKey) {
      throw new SignalError(
        'config_missing',
        'BING_WEBMASTER_API_KEY is not configured.',
      );
    }
    sites = await getBingVerifiedSites(apiKey, bingFetch);
  } catch (error) {
    // ONE dead discovery call is one fact about this OS, not N about the
    // portfolio. Returning here is also what keeps `bwt_site_unverified` — a
    // property-blaming code — unreachable on a night no site list arrived.
    if (await egressExplains(gate, transport, error)) {
      for (const candidate of candidates) {
        const mapped = bingSiteMapping(
          candidate.asset,
          candidate.domain,
          null,
          options.laneRegister,
        );
        const target = bingTarget(candidate, mapped?.value ?? candidate.domain, ref);
        outcomes.push(unmeasuredOutcome(gate, target, mapped?.source ?? 'domain-match'));
      }
      return finish(outcomes, gate, options.configSources, monitoring);
    }
    const normalized = normalizeSignalError(error, 'Bing Webmaster request failed.');
    for (const candidate of candidates) {
      // No site list was fetched, so only the register can name a site here;
      // its mapping is still the register's, because what failed was the
      // credential, not the mapping.
      const mapped = bingSiteMapping(
        candidate.asset,
        candidate.domain,
        null,
        options.laneRegister,
      );
      const target = bingTarget(candidate, mapped?.value ?? candidate.domain, ref);
      await recordSignalFailure(env, target, requestedWindow, nowMs, normalized, monitoring);
      outcomes.push(errorOutcome(target, normalized, mapped?.source ?? 'domain-match'));
    }
    // Every property fails with the credential, so the credential's own status
    // has to say so.
    if (source === 'store') {
      await recordCredentialOutcome(env, 'bing-webmaster', {
        ok: false,
        error: normalized.message,
      });
    }
    return finish(outcomes, gate, options.configSources, monitoring);
  }

  for (const candidate of candidates) {
    // The register first, the verified-site domain match second.
    const mapped = bingSiteMapping(
      candidate.asset,
      candidate.domain,
      sites,
      options.laneRegister,
    );
    const siteUrl = mapped?.value;
    const target = bingTarget(candidate, siteUrl ?? candidate.domain, ref);
    const startedAt = new Date().toISOString();
    if (!siteUrl) {
      const error = new SignalError(
        'bwt_site_unverified',
        `Bing Webmaster does not list a verified site for ${candidate.domain}.`,
      );
      await recordSignalFailure(
        env,
        target,
        requestedWindow,
        Date.parse(startedAt),
        error,
        monitoring,
      );
      outcomes.push(errorOutcome(target, error, 'domain-match'));
      continue;
    }

    try {
      const result = await collectTraffic(
        siteUrl,
        requestedWindow,
        apiKey,
        bingFetch,
      );
      const observedWindow = windowThroughLatestObservation(
        requestedWindow,
        result.observations,
      );
      await recordSignalSuccess(env, target, observedWindow, startedAt, result, monitoring);
      outcomes.push({
        asset: target.asset,
        integration: target.integration,
        status: 'success',
        providerRows: result.providerRows,
        observationCount: result.observations.length,
        errorCode: null,
        mappingSource: mapped.source,
      });
    } catch (error) {
      // The uplink can also die after discovery answered.
      if (await egressExplains(gate, transport, error)) {
        outcomes.push(unmeasuredOutcome(gate, target, mapped.source));
        continue;
      }
      const normalized = normalizeSignalError(error, 'Bing Webmaster request failed.');
      await recordSignalFailure(
        env,
        target,
        requestedWindow,
        Date.parse(startedAt),
        normalized,
        monitoring,
      );
      outcomes.push(errorOutcome(target, normalized, mapped.source));
    }
  }

  // Bing answered the site list, so the key works whatever individual
  // properties did. `last_ok_at` is a fact about the CREDENTIAL, not about
  // coverage — an unverified site is not a broken key.
  if (source === 'store') {
    await recordCredentialOutcome(env, 'bing-webmaster', { ok: true });
  }
  return finish(outcomes, gate, options.configSources, monitoring);
}

/** A property the dead uplink left uncollected: named on the run's one
 * `os-egress-down` flag and nowhere else. */
function unmeasuredOutcome(
  gate: EgressGate,
  target: BingWebmasterTarget,
  mappingSource: LaneMappingSource,
): BingSignalOutcome {
  gate.recordUnmeasured(target.asset);
  return {
    asset: target.asset,
    integration: target.integration,
    status: 'error',
    providerRows: 0,
    observationCount: 0,
    errorCode: EGRESS_DOWN_CODE,
    mappingSource,
    egressDown: true,
  };
}

async function collectTraffic(
  siteUrl: string,
  window: SignalDateWindow,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<SignalProviderResult> {
  const body = await bingRequest(
    'GetRankAndTrafficStats',
    { siteUrl },
    apiKey,
    fetchImpl,
  );
  const rows = bingResponseRows(body, 'bwt_traffic_invalid_response');
  const daily = new Map<string, { clicks: number; impressions: number }>();
  for (const value of rows) {
    const row = asRecord(value);
    const date = parseBingDate(row?.Date ?? row?.date);
    if (!date || date < window.start || date > window.end) continue;
    daily.set(date, {
      clicks: finiteValue(row?.Clicks ?? row?.clicks),
      impressions: finiteValue(row?.Impressions ?? row?.impressions),
    });
  }

  const observations: SignalObservation[] = [...daily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([date, value]) => [
      { date, metric: 'clicks', value: value.clicks },
      { date, metric: 'impressions', value: value.impressions },
    ]);
  return {
    providerRows: rows.length,
    observations,
    dataState: 'final',
    provisionalFrom: null,
  };
}

function collectionWindow(nowMs: number): SignalDateWindow {
  const end = new Date(nowMs);
  const start = new Date(
    end.getTime() - (LIVE_SIGNAL_WINDOW_DAYS - 1) * 86_400_000,
  );
  return { start: formatDate(start), end: formatDate(end) };
}

function windowThroughLatestObservation(
  requested: SignalDateWindow,
  observations: SignalObservation[],
): SignalDateWindow {
  if (observations.length === 0) return requested;
  const dates = observations.map((observation) => observation.date).sort();
  return { start: dates[0]!, end: dates.at(-1)! };
}

function errorOutcome(
  target: BingWebmasterTarget,
  error: SignalError,
  mappingSource: LaneMappingSource,
): BingSignalOutcome {
  return {
    asset: target.asset,
    integration: target.integration,
    status: 'error',
    providerRows: 0,
    observationCount: 0,
    errorCode: error.code,
    mappingSource,
  };
}

async function finish(
  outcomes: BingSignalOutcome[],
  gate: EgressGate,
  configSources: ConfigSourceMap | undefined,
  monitoring: CollectionMonitoring,
): Promise<BingSignalsResult> {
  const result = {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    outcomes,
    // One `os-egress-down` fact for the run — or the retraction of an open one.
    egress: await gate.finalize(),
  };
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  console.log(
    JSON.stringify({
      event: 'bing_signals_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
      // `store` means this run read the document an operator saved; `file`
      // means the copy compiled into this Worker.
      ...configSourceLine(configSources, ['config/integrations.json']),
      // Which mapping named each site.
      mappingSources: mappingSourceTally(
        outcomes.map((outcome) => outcome.mappingSource),
      ),
      // Bing's failures only; what the uplink swallowed is counted, not listed.
      errors: measured
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, errorCode }) => ({ asset, errorCode })),
      unmeasured: outcomes.length - measured.length,
    }),
  );
  return { ...result, ...collectionMonitoring(monitoring) };
}

function finiteValue(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new SignalError(
      'bwt_traffic_invalid_response',
      'Bing Webmaster returned a non-numeric traffic value.',
    );
  }
  return number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
