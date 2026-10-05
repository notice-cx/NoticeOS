import { tryHealthConnection } from './integration-health-context.js';
import { beginCollection, collectionMonitoring } from './collection-attempt.js';
// Operator-owned GA4 + Google Search Console collectors.
//
// The credential map is account-centric: one base64-encoded service-account
// key can serve several properties without duplicating the secret. A token is
// minted once per account + OAuth scope and reused for every mapped property.
// Raw credentials and access tokens are never persisted or logged.
//
// SINCE `ro-vu8d.3` THERE ARE TWO WAYS IN. An account entry that names no
// `service_account_b64` authenticates with the operator's SIGN-IN instead
// (`google-oauth.ts`), and every token this file asks for goes through the one
// door in `google-auth.ts` — so nothing below branches on which kind it holds.
// What the two paths still do NOT share is the property map: a sign-in tells
// the OS which properties exist, and which ASSET each belongs to is the
// operator's answer.
//
// SINCE `ro-vu8d.16` THAT ANSWER IS THE REGISTER (`lane-mapping.ts`). A GA4
// property id or Search Console site saved on an asset's Sources tab beats the
// credential blob's own `properties` map for that asset, and an install that
// signed in without ever pasting a blob collects whatever the register maps —
// which is what makes the sign-in enough. An asset the register says nothing
// about keeps exactly the behaviour it had: the credential's value, or nothing
// at all, said once per pull rather than thrown.
//
// AND SINCE `ro-90mr` THE BLOB'S PROPERTY MAP RETIRES ITSELF. Two places held
// one fact, which is what D21 and the one-representation rule refuse; the copy
// inside `GOOGLE_SIGNAL_ACCOUNTS` lived on only so the change above could land
// without an operator migration. `parseGoogleTargets` now decides per lane,
// before it reads anything, whether that copy is still the ONLY answer for any
// asset the blob names — and stops reading `ga4_property_id` / `gsc_site_url`
// where it is not. What the blob always keeps is the routing (which account
// authenticates which asset) and each entry's `time_zone`.

import {
  OS_TIME_ZONE,
  type CredentialSource,
  type CredentialStoreState,
  integrationProvider,
  providerReportingTimeZone,
} from '@noticeos/contract';
import {
  recordCredentialOutcome,
  resolveCredential as resolveStoredCredential,
  sourcedCredentialRef,
  usesLegacyCredentialBindings,
} from './credentials.js';
import { countOf, failureWords } from './integration-health-store.js';
import {
  type GoogleAuth,
  type GoogleOAuthGrant,
  type GoogleServiceAccount,
  GOOGLE_OAUTH_REVOKED_CODE,
  GOOGLE_OAUTH_REVOKED_MESSAGE,
  GOOGLE_SCOPES,
  arrayField,
  asRecord,
  decodeServiceAccount,
  googleAccessToken,
  googleAuthCacheKey,
  googleGrantHint,
  isGoogleAuthExpiry,
  mintGoogleAccessToken,
  providerError,
  responseJson,
  stringField,
} from './google-auth.js';
import { resolveGoogleCredential } from './google-oauth.js';
import { type ConfigSourceMap, configSourceLine } from './config-store.js';
import {
  EGRESS_DOWN_CODE,
  EGRESS_NOT_ASKED,
  EgressGate,
  type EgressRunOutcome,
  egressExplains,
  watchTransport,
} from './egress.js';
import {
  type LaneMappingSource,
  type LaneRegister,
  credentialPropertyMapNeeded,
  credentialPropertyMapUse,
  laneDeclined,
  mappingSourceTally,
  registerMappedAssets,
  resolveLaneRef,
} from './lane-mapping.js';
import {
  GA4_QUOTA_EXHAUSTED_CODE,
  isQuotaExhausted,
  parseGa4PropertyQuota,
  recordGa4Quota,
} from './ga4-quota.js';
import { dateInTimeZone } from './time-zone.js';
import {
  previousTimeZone,
  recordTimeZoneChange,
} from './time-zone-change.js';
import {
  normalizeSignalError,
  recordSignalFailure,
  recordSignalSuccess,
  LIVE_SIGNAL_WINDOW_DAYS,
  SignalError,
  type SignalDateWindow,
  type SignalObservation,
  type SignalProviderResult,
  type SignalTarget,
} from './signal-store.js';

// Re-exported rather than moved out of every caller's import: these are the
// GOOGLE vocabulary, and `google-auth.ts` (bead `ro-vu8d.3`) is where they now
// live because both auth paths need them. A collector that has always said
// `from './google-signals.js'` keeps saying it.
export {
  GOOGLE_SCOPES,
  mintGoogleAccessToken,
  providerError,
  responseJson,
  type GoogleAuth,
  type GoogleServiceAccount,
} from './google-auth.js';

const REQUEST_TIMEOUT_MS = 20_000;
/**
 * What day boundary to assume for a GA4 property whose config entry names no
 * `time_zone`, when the caller has not resolved the saved one.
 *
 * THE OPERATOR'S CONFIGURED CLOCK, not a literal (bead `ro-toa0`). It was
 * the operator's own zone written here, which is a fact about ONE portfolio
 * baked into a Worker source file: a self-hoster whose properties report in
 * another zone got silently mis-bucketed rows every time the config omitted
 * the zone, and the only way to fix it was to edit TypeScript. `os_time_zone`
 * in `config/constants.json` is the one timezone a self-hoster already sets, so
 * it is the honest guess — the install's own clock rather than ours.
 *
 * A guess is still a guess. It is announced once per pull (see
 * `assumedTimeZoneEvent`) so a wrong one is visible in the log rather than only
 * in a chart that looks a few hours off. The exact answer is always the config
 * entry's own `time_zone`, and the provider's `metadata.timeZone` is watched
 * separately (`ro-tzq`) for the day a property's real boundary moves.
 */
const DEFAULT_GA4_TIME_ZONE = OS_TIME_ZONE;
// AND THE SAVED ONE FIRST (bead `ro-ujb9.88`): since D22 `/settings` saves
// `os_time_zone` into the config store without a rebuild. Every lane that
// resolves the store passes its saved zone as `assumedTimeZone` below; this
// compiled copy is only the fallback for a caller that did not.
/**
 * Search Console's day boundary. A REAL constant and deliberately not the
 * configured clock: Google documents every Search Console property as reporting
 * in Pacific Time regardless of where the property or its owner is, so this is
 * the provider's contract rather than an assumption about the operator. It is
 * declared once, in the provider catalog (`reportingTimeZones`, bead
 * `ro-ujb9.118`), beside Google's other facts.
 */
const GSC_TIME_ZONE: string = requiredReportingTimeZone('gsc');

function requiredReportingTimeZone(lane: string): string {
  const zone = providerReportingTimeZone(lane);
  if (zone === null) throw new Error(`the provider catalog declares no reporting time zone for ${lane}`);
  return zone;
}

export type GoogleIntegrationId = 'ga4' | 'gsc';

export interface GooglePropertyTarget extends SignalTarget {
  account: string;
  asset: string;
  integration: GoogleIntegrationId;
  propertyRef: string;
  /** GA4's reporting day boundary. GSC is always queried in documented PT. */
  timeZone: string;
  /** True when `timeZone` above is the OS clock STANDING IN for a config entry
   * that named none — an assumption, not something the operator stated. Kept on
   * the target so the pull can announce it once instead of the parse announcing
   * it on every 30-second realtime read. */
  timeZoneAssumed: boolean;
  /** How this property is authenticated — the account entry's own
   * service-account key, or the operator's sign-in when it names none. */
  auth: GoogleAuth;
  /** Where `propertyRef` came from (bead `ro-vu8d.16`): the asset's own entry in
   * `config/integrations.json`, or the credential blob's legacy property map. */
  mappingSource: LaneMappingSource;
}

export interface GoogleSignalOutcome {
  asset: string;
  integration: GoogleIntegrationId;
  status: 'success' | 'error';
  providerRows: number;
  observationCount: number;
  errorCode: string | null;
  /** Which mapping this attempt ran on (bead `ro-vu8d.16`). */
  mappingSource: LaneMappingSource;
  /**
   * True when the collection failed because the OS's own uplink was down (bead
   * `ro-aed0.1`). Still a failure — nothing was collected — but no `signal_runs`
   * row and no Health observation accuses the property or Google; the run's one
   * `os-egress-down` flag carries the fact instead (src/egress.ts).
   */
  egressDown?: true;
}

export interface GoogleSignalsResult {
  attempted: number;
  succeeded: number;
  failed: number;
  outcomes: GoogleSignalOutcome[];
  /** What the run's egress gate concluded — see {@link EgressRunOutcome}. */
  egress: EgressRunOutcome;
}

export interface GoogleSignalsOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  rawConfig?: string;
  /** Override the compiled-in config/integrations.json mapping (tests state
   * their own register instead of editing the operator's file). */
  laneRegister?: LaneRegister;
  /** Where this run's config came from, per file — resolved once per cron fire
   * in dispatch.ts and reported on the completion line below (`ro-syok.7`). */
  configSources?: ConfigSourceMap;
  /** The operator's saved clock (config/constants.json `os_time_zone`, store
   * first — bead `ro-ujb9.88`), assumed for a GA4 property that states no
   * zone of its own. Absent: the zone compiled into this Worker. */
  osTimeZone?: string;
  /** Override the run's egress gate (tests control the verdict TTL); every other
   * caller gets a real one over the same fetcher. */
  egress?: EgressGate;
  /** Collect only these assets — the connect panel's Start (bead
   * `ro-ujb9.96.7.7`). Narrower than the schedule, never wider: each still
   * needs its mapping. */
  assets?: readonly string[];
}

type GoogleCredentialResolver = (binding: string) => string | undefined;

export async function runGoogleSignals(
  env: IngestEnv,
  options: GoogleSignalsOptions = {},
): Promise<GoogleSignalsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  // CAN THE OS GET OUT (bead `ro-aed0.1`)? One gate per run, asked only when a
  // Google call came back with no status at all. On 2026-08-08 a dead uplink
  // killed the token mint before any property was contacted and this lane wrote
  // a `request_failed` row per property per integration — each one that
  // property's latest evidence, rendered as "Google returned request_failed".
  // The gate's beacons use the raw fetcher; only Google's calls are watched.
  const gate = options.egress ?? new EgressGate(env, { lane: 'google-signals', fetchImpl, at: new Date(nowMs).toISOString() });
  const transport = watchTransport(fetchImpl);
  const googleFetch = transport.fetch;
  // Store first, legacy env binding second (bead `ro-vu8d.1`). A caller that
  // handed us the raw config is a test, so nothing was resolved and the source
  // is `env` by definition.
  const resolved = await resolveGoogleCredential(env);
  const health = await tryHealthConnection(env, 'google', resolved.credential, [resolved.oauth?.clientId ?? '', resolved.oauth?.clientSecret ?? '']);
  const monitoring = beginCollection(env.STORE, health);
  const source: CredentialSource =
    options.rawConfig === undefined ? resolved.source : 'env';
  const accounts = options.rawConfig ?? resolved.accounts;

  // A property its Data sources row declines (Not using) is not asked for —
  // the one skip rule every collector applies (`laneDeclined`, bead
  // `ro-ujb9.96.7.18`).
  const targets = googleTargets(
    { accounts, oauth: resolved.oauth, connected: resolved.connected },
    source,
    googleCredentialResolver(env),
    options.laneRegister,
    options.osTimeZone,
  ).filter((target) => !laneDeclined(target.asset, target.integration, options.laneRegister)
    && (options.assets === undefined || options.assets.includes(target.asset)));

  // SIGNED IN, WITH NOTHING MAPPED ANYWHERE. An install that connected with
  // OAuth, never pasted an account map and has not mapped an asset on its
  // Sources tab has a working credential and nothing to point it at. That is a
  // state to REPORT, not a config error: throwing `config_missing` here would
  // put a red lane on a card the operator just connected successfully. Google
  // not connected at all is the same no-work run (bead `ro-ujb9.172`).
  if (targets.length === 0 && accounts === undefined) {
    console.log(JSON.stringify({
      event: resolved.oauth === null ? 'google_signals_not_connected' : 'google_signals_no_properties_mapped',
    }));
    // Nothing was asked of anyone, so there is no verdict to file either way.
    return { attempted: 0, succeeded: 0, failed: 0, outcomes: [], egress: EGRESS_NOT_ASKED };
  }

  // ONE line per pull naming the properties whose day boundary we ASSUMED
  // (bead `ro-toa0`). A wrong assumption does not fail anything — it shifts
  // which events land on which day, which reads downstream as a chart that is
  // a few hours out of step and points nowhere near its cause. So the guess
  // says so, once, here rather than in `parseGoogleTargets`: the same parse
  // runs on every 30-second realtime read, and a warning at that rate is a
  // warning nobody reads.
  const assumed = assumedTimeZoneEvent(targets);
  if (assumed) console.warn(JSON.stringify(assumed));

  const outcomes: GoogleSignalOutcome[] = [];

  for (const [account, accountTargets] of groupGoogleTargetsByAccount(targets)) {
    const auth = accountTargets[0]!.auth;
    for (const integration of ['ga4', 'gsc'] as const) {
      const scopedTargets = accountTargets.filter((target) => target.integration === integration);
      if (scopedTargets.length === 0) continue;

      let accessToken: string;
      try {
        accessToken = await googleAccessToken(
          auth,
          GOOGLE_SCOPES[integration],
          nowMs,
          googleFetch,
        );
      } catch (error) {
        // ONE dead mint used to fan into a failure row per property. When the
        // uplink is what failed, none of them was measured and none is blamed.
        if (await egressExplains(gate, transport, error)) {
          for (const target of scopedTargets) outcomes.push(unmeasuredOutcome(gate, target));
          continue;
        }
        const normalized = normalizeSignalError(error, 'Google request failed.');
        for (const target of scopedTargets) {
          const window = collectionWindow(target, nowMs);
          await recordSignalFailure(env, target, window, nowMs, normalized, monitoring);
          outcomes.push(errorOutcome(target, normalized));
        }
        continue;
      }

      for (const target of scopedTargets) {
        const window = collectionWindow(target, nowMs);
        const startedAt = new Date().toISOString();
        try {
          const result = await withFreshTokenOnce(
            auth,
            GOOGLE_SCOPES[integration],
            accessToken,
            nowMs,
            googleFetch,
            (token) =>
              integration === 'ga4'
                ? collectGa4(target.propertyRef, window, token, googleFetch)
                : collectGsc(target.propertyRef, window, token, googleFetch),
            (token) => {
              // The whole account shares the token, so a refresh earned by one
              // property is spent by the rest of the loop rather than minted
              // again per property.
              accessToken = token;
            },
          );

          // Read the PREVIOUS timezone before writing this run, or this run
          // becomes its own predecessor and no change is ever visible.
          const priorTimeZone = result.timeZone
            ? await previousTimeZone(env.STORE, target.asset, integration, target.propertyRef)
            : null;

          await recordSignalSuccess(env, target, window, startedAt, result, monitoring);

          // A reporting timezone changing means the property's DAY changed
          // shape, and the provider does not reprocess what it already bucketed
          // (`ro-tzq`). Recorded on the timeline so every later comparison can
          // ask whether its window spans it — the collection itself is
          // unaffected and must not fail over it.
          if (
            result.timeZone &&
            priorTimeZone &&
            priorTimeZone !== result.timeZone
          ) {
            try {
              await recordTimeZoneChange(env, {
                asset: target.asset,
                integration,
                from: priorTimeZone,
                to: result.timeZone,
                // The provider day the two definitions stop agreeing on is the
                // day this run is reporting through — the first day collected
                // under the new boundary.
                effectiveOn: window.end,
              });
            } catch {
              // Never fail a collection over its own bookkeeping. The next run
              // sees the same difference and files again; the annotation's
              // identity makes that a duplicate rather than a second event.
            }
          }
          if (integration === 'ga4') {
            await recordGa4Quota(env, {
              asset: target.asset,
              lane: 'google-signals',
              propertyRef: target.propertyRef,
              quota: result.quota ?? null,
              at: new Date(nowMs).toISOString(),
            });
          }
          outcomes.push({
            asset: target.asset,
            integration,
            status: 'success',
            providerRows: result.providerRows,
            observationCount: result.observations.length,
            errorCode: null,
            mappingSource: target.mappingSource,
          });
        } catch (error) {
          // The uplink can also die mid-run, after the token was minted.
          if (await egressExplains(gate, transport, error)) {
            outcomes.push(unmeasuredOutcome(gate, target));
            continue;
          }
          const normalized = normalizeSignalError(error, 'Google request failed.');
          await recordSignalFailure(env, target, window, Date.parse(startedAt), normalized, monitoring);
          outcomes.push(errorOutcome(target, normalized));
        }
      }
    }

    console.log(
      JSON.stringify({
        event: 'google_signals_account_complete',
        account,
        attempted: outcomes.filter((outcome) =>
          accountTargets.some(
            (target) =>
              target.asset === outcome.asset && target.integration === outcome.integration,
          ),
        ).length,
      }),
    );
  }

  const result = {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    outcomes,
  };
  // One `os-egress-down` fact for the whole run, however many properties the
  // dead uplink left unmeasured — and, on the run that gets through again, the
  // retraction of the one an earlier run left open.
  const egress = await gate.finalize();
  // What this run actually MEASURED. A collection the uplink swallowed says
  // nothing about the credential or the property, so it may not stamp either.
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  // One stamp per pull on the CREDENTIAL, not per property: a service account
  // that minted a token and returned rows for anything is a working credential,
  // and a property-level failure is the property's story (db/0028). A run the
  // uplink swallowed whole stamps nothing: no measurement is not a verdict.
  if (source === 'store' && !(outcomes.length > 0 && measured.length === 0)) {
    const firstError = measured.find((outcome) => outcome.status === 'error');
    // A REVOKED GRANT GETS ITS OWN SENTENCE (bead `ro-vu8d.14`). Every other
    // failure here is a property's story and the credential's column carries a
    // code the operator can quote; this one is a statement about the CREDENTIAL
    // — nothing about any property is wrong — and it is the only column the
    // Integrations card will show, so it has to say what to do rather than name
    // an enum. `google_oauth_revoked` reaches every property at once, which is
    // why a single stamp can speak for the whole run.
    const revoked = measured.every(
      (outcome) =>
        outcome.status !== 'error' || outcome.errorCode === GOOGLE_OAUTH_REVOKED_CODE,
    );
    // Any other failure is one line (bead `ro-ujb9.96.6.31`): what went wrong
    // in a site row's words, then how many properties — never the code, which
    // each property's own run keeps.
    const failed = measured.filter((outcome) => outcome.status === 'error');
    await recordCredentialOutcome(env, 'google', {
      ok: result.succeeded > 0,
      error:
        result.succeeded > 0
          ? null
          : revoked && firstError?.errorCode === GOOGLE_OAUTH_REVOKED_CODE
            ? GOOGLE_OAUTH_REVOKED_MESSAGE
            : [
                ...failureWords(failed.map((outcome) => outcome.errorCode)),
                countOf(failed.length, measured.length, 'property', 'properties'),
              ].join(' · '),
    });
  }
  console.log(
    JSON.stringify({
      event: 'google_signals_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
      // WHERE THE MAPPING ITSELF CAME FROM (bead `ro-syok.7`) — `store` means
      // this run read the document an operator saved, with no restart between
      // the Save and the run; `file` means the copy compiled into this Worker.
      ...configSourceLine(options.configSources, ['config/integrations.json']),
      // WHICH MAPPING THIS PULL RAN ON (bead `ro-vu8d.16`) — `{register: 2,
      // credential: 2}` reads as two assets steered by their own Sources tab and
      // two still on the legacy credential map. No property ids here: the
      // per-property value is already `signal_runs.property_ref`.
      mappingSources: mappingSourceTally(
        outcomes.map((outcome) => outcome.mappingSource),
      ),
      // Provider failures only. A collection the uplink swallowed is counted in
      // `failed` and here, never listed as Google's error (bead `ro-aed0.1`).
      errors: measured
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, integration, errorCode }) => ({ asset, integration, errorCode })),
      unmeasured: outcomes.length - measured.length,
    }),
  );
  return { ...result, egress, ...collectionMonitoring(monitoring) };
}

/**
 * A collection the dead uplink swallowed: noted on the gate (which names the
 * property on the run's one `os-egress-down` flag) and nowhere else — no
 * `signal_runs` row, no Health observation, no word against Google.
 */
function unmeasuredOutcome(gate: EgressGate, target: GooglePropertyTarget): GoogleSignalOutcome {
  gate.recordUnmeasured(target.asset);
  return {
    asset: target.asset,
    integration: target.integration,
    status: 'error',
    providerRows: 0,
    observationCount: 0,
    errorCode: EGRESS_DOWN_CODE,
    mappingSource: target.mappingSource,
    egressDown: true,
  };
}

/**
 * Run one provider call, and on a 401 get a fresh token and run it ONCE more.
 *
 * WHY ONCE AND NOT A LOOP. A 401 has exactly two causes worth retrying: a token
 * that expired between minting and using (the pull loop can outlive an hour on
 * a portfolio with many properties) and, on the OAuth path, an access token
 * invalidated early. Both are fixed by the second attempt. Anything that
 * answers 401 twice is a credential or a grant problem, and retrying it again
 * would turn a broken credential into a burst of requests against Google.
 *
 * A REVOKED grant is deliberately not retried: `refreshGoogleAccessToken`
 * raises `google_oauth_revoked` rather than an HTTP failure, so it propagates
 * as itself and the operator is told to reconnect instead of watching a lane
 * fail with a 401 that is not about this token at all.
 */
async function withFreshTokenOnce<T>(
  auth: GoogleAuth,
  scope: string,
  token: string,
  nowMs: number,
  fetchImpl: typeof fetch,
  run: (token: string) => Promise<T>,
  onRefresh: (token: string) => void,
): Promise<T> {
  try {
    return await run(token);
  } catch (error) {
    if (!isGoogleAuthExpiry(error)) throw error;
    const fresh = await googleAccessToken(auth, scope, nowMs, fetchImpl);
    onRefresh(fresh);
    return run(fresh);
  }
}

export interface AssumedTimeZoneEvent {
  event: 'ga4_time_zone_assumed';
  /** The zone that stood in — `config/constants.json` `os_time_zone`. */
  timeZone: string;
  /** The GA4 properties it stood in for, in config order. */
  assets: string[];
}

/**
 * The warning, or null when every GA4 property stated its own zone.
 *
 * Built apart from the printing so the suite can pin its shape: inside workerd
 * a test cannot see the lane's own console. GSC targets are excluded — their
 * boundary is Google's documented PT and was never a guess.
 */
export function assumedTimeZoneEvent(
  targets: GooglePropertyTarget[],
): AssumedTimeZoneEvent | null {
  const assumed = targets.filter(
    (target) => target.integration === 'ga4' && target.timeZoneAssumed,
  );
  if (assumed.length === 0) return null;
  // Every assumed target carries the one zone its caller assumed.
  return {
    event: 'ga4_time_zone_assumed',
    timeZone: assumed[0]!.timeZone,
    assets: assumed.map((target) => target.asset),
  };
}

/**
 * EVERY GOOGLE PROPERTY THIS INSTALL COLLECTS, from both mappings at once
 * (bead `ro-vu8d.16`) — the one door the two Google lanes share, so the live
 * collector and the archive can never disagree about what is configured.
 *
 * Order is the precedence: the credential blob's own entries are parsed first
 * (with the register overriding each ref it holds), then the register's own
 * mapped assets are added for anything the blob did not cover. An asset can
 * therefore be moved off the blob a field at a time, and nothing collects twice.
 *
 * The edge cases. Google not connected at all (`connected: false`, what the
 * Integrations card reads as not connected) is no work: nothing is asked and a
 * scheduled lane reads skipped, like every other provider nobody set up (bead
 * `ro-ujb9.172`). No blob and no sign-in on anything else — a stored row that
 * lost its map or cannot be opened, or a caller that did not say — is still
 * `config_missing` with its old sentence: an install on service accounts must
 * not start reading "sign in" at it. A sign-in with no blob returns whatever
 * the register maps, which is empty until an asset is mapped, and each caller
 * says so in its own words rather than failing.
 */
export function googleTargets(
  credential: { accounts: string | undefined; oauth: GoogleOAuthGrant | null; connected?: boolean },
  source: CredentialSource = 'env',
  resolveCredential?: GoogleCredentialResolver,
  register?: LaneRegister,
  /** The operator's saved clock, for a GA4 property that states no zone. */
  assumedTimeZone: string = DEFAULT_GA4_TIME_ZONE,
): GooglePropertyTarget[] {
  if (credential.connected === false && credential.accounts === undefined && credential.oauth === null) return [];
  const fromCredential =
    credential.accounts === undefined && credential.oauth !== null
      ? []
      : parseGoogleTargets(
          credential.accounts,
          resolveCredential,
          source,
          credential.oauth,
          register,
          assumedTimeZone,
        );
  if (credential.oauth === null) return fromCredential;
  const covered = new Set(
    fromCredential.map((target) => `${target.asset}\0${target.integration}`),
  );
  return [
    ...fromCredential,
    ...registerGoogleTargets(credential.oauth, source, register, assumedTimeZone).filter(
      (target) => !covered.has(`${target.asset}\0${target.integration}`),
    ),
  ];
}

/**
 * `source` says where `raw` came from, and rides into every target's
 * `credentialRef` so `signal_runs` records whether a pull ran on the product's
 * credential or on the legacy `.dev.vars` one (bead `ro-vu8d.1`). It defaults to
 * `env`, which is what every caller that has no opinion has always recorded.
 */
export function parseGoogleTargets(
  raw: string | undefined,
  resolveCredential?: GoogleCredentialResolver,
  source: CredentialSource = 'env',
  oauth: GoogleOAuthGrant | null = null,
  register?: LaneRegister,
  assumedTimeZone: string = DEFAULT_GA4_TIME_ZONE,
): GooglePropertyTarget[] {
  if (!raw) throw new SignalError('config_missing', 'GOOGLE_SIGNAL_ACCOUNTS is not configured.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const first = raw.codePointAt(0)?.toString(16).toUpperCase() ?? 'none';
    const last = raw.codePointAt(raw.length - 1)?.toString(16).toUpperCase() ?? 'none';
    throw new SignalError(
      'config_invalid',
      `GOOGLE_SIGNAL_ACCOUNTS is not valid JSON (${raw.length} characters; boundary U+${first}/U+${last}).`,
    );
  }
  const root = asRecord(parsed);
  if (!root) throw new SignalError('config_invalid', 'GOOGLE_SIGNAL_ACCOUNTS must be an object.');

  // WHICH HALVES OF THIS BLOB ARE STILL LOAD-BEARING (bead `ro-90mr`), decided
  // before a single property id is read. The pass below looks at the `properties`
  // KEYS only — the routing half, which stays — and asks the register whether it
  // answers for every one of them on each lane. Where it does, `ga4_property_id`
  // / `gsc_site_url` are not read at all on that lane: the register was already
  // winning for every asset that could have consulted them, so letting go costs
  // nothing and the second copy of the fact stops being read the day the last
  // asset is mapped. Where it does not, this is exactly today's behaviour.
  const named = blobPropertyAssets(root);
  const credentialAnswers: Record<GoogleIntegrationId, boolean> = {
    ga4: credentialPropertyMapNeeded(named, 'ga4', register),
    gsc: credentialPropertyMapNeeded(named, 'gsc', register),
  };

  const targets: GooglePropertyTarget[] = [];
  const seen = new Set<string>();
  for (const [account, value] of Object.entries(root)) {
    const entry = asRecord(value);
    const inlineCredential = stringField(entry, 'service_account_b64');
    const credentialBinding = stringField(entry, 'service_account_binding');
    if (inlineCredential && credentialBinding) {
      throw new SignalError(
        'config_invalid',
        `Google account "${account}" must use either service_account_b64 or service_account_binding, not both.`,
      );
    }
    const encoded =
      inlineCredential ??
      (credentialBinding ? resolveCredential?.(credentialBinding) ?? null : null);
    const properties = asRecord(entry?.properties);
    // AN ENTRY WITH NO KEY IS NOT A BROKEN ENTRY ANY MORE (bead `ro-vu8d.3`):
    // when the operator has signed in, the map may carry properties alone and
    // the grant authenticates them. Without a sign-in it is still the old
    // error, with the old sentence — an install on service accounts must not
    // start reading "sign in" at it.
    const auth: GoogleAuth | null = encoded
      ? { kind: 'service-account', account: decodeServiceAccount(encoded, account) }
      : oauth === null
        ? null
        : { kind: 'oauth', grant: oauth };
    if (!entry || !auth || !properties) {
      throw new SignalError(
        'config_invalid',
        credentialBinding
          ? `Google account "${account}" needs credential binding "${credentialBinding}" and a properties object.`
          : `Google account "${account}" needs service_account_b64 and a properties object.`,
      );
    }
    for (const [asset, propertyValue] of Object.entries(properties)) {
      const property = asRecord(propertyValue);
      if (!property) {
        throw new SignalError('config_invalid', `Google property "${asset}" must be an object.`);
      }
      const configuredTimeZone = stringField(property, 'time_zone');
      const timeZone = configuredTimeZone ?? assumedTimeZone;
      validateTimeZone(timeZone, asset);
      // THE REGISTER FIRST, THIS BLOB SECOND (bead `ro-vu8d.16`) — AND ONLY
      // WHILE THE BLOB IS STILL SOMEBODY'S ONLY ANSWER (bead `ro-90mr`). The
      // asset's own `config/integrations.json` entry is the operator's answer and
      // wins; `ga4_property_id` / `gsc_site_url` are what an unmapped asset still
      // reads, which is why nothing about an install that has mapped nothing
      // changes. `credentialAnswers` above is what makes the second copy go: on a
      // lane where every asset this blob names is mapped, the field is not read,
      // so a stale property id left behind in the credential cannot steer
      // anything and the map is free to shrink to its routing.
      const refs: [GoogleIntegrationId, ReturnType<typeof resolveLaneRef>][] = [
        [
          'ga4',
          resolveLaneRef(
            asset,
            'ga4',
            {
              value: credentialAnswers.ga4 ? stringField(property, 'ga4_property_id') : null,
              source: 'credential',
            },
            register,
          ),
        ],
        [
          'gsc',
          resolveLaneRef(
            asset,
            'gsc',
            {
              value: credentialAnswers.gsc ? stringField(property, 'gsc_site_url') : null,
              source: 'credential',
            },
            register,
          ),
        ],
      ];
      for (const [integration, mapped] of refs) {
        if (!mapped) continue;
        const key = `${asset}\0${integration}`;
        if (seen.has(key)) {
          throw new SignalError(
            'config_duplicate',
            `${asset} is assigned to more than one ${integration.toUpperCase()} credential.`,
          );
        }
        seen.add(key);
        targets.push({
          account,
          asset,
          integration,
          credentialRef: sourcedCredentialRef(account, source),
          propertyRef: mapped.value,
          timeZone,
          timeZoneAssumed: configuredTimeZone === null,
          auth,
          mappingSource: mapped.source,
        });
      }
    }
  }
  return targets;
}

/**
 * Every asset the account map NAMES, across all of its accounts (bead `ro-90mr`).
 *
 * The keys of each entry's `properties` object and nothing else — this is the
 * routing half, the one the blob keeps once the property ids go. It is
 * deliberately forgiving where the validating pass is strict: a malformed entry
 * is an error the loop below still raises with its own sentence, and answering
 * "this asset is named" for it only ever keeps the credential map in play, which
 * is the conservative side of the question.
 */
function blobPropertyAssets(root: Record<string, unknown>): string[] {
  const assets: string[] = [];
  for (const value of Object.values(root)) {
    const properties = asRecord(asRecord(value)?.properties);
    if (properties) assets.push(...Object.keys(properties));
  }
  return assets;
}

/**
 * WHICH ASSETS THIS INSTALL'S GOOGLE CREDENTIAL NAMES — the one input the
 * property-map question takes, answered where the blob can actually be read
 * (bead `ro-vu8d.22`).
 *
 * `null` means *this credential has no property map to talk about*, and the
 * card then says nothing rather than guessing. Three cases reach it and all
 * three are honest: an install that signed in and never pasted an account map,
 * a credential whose bootstrap key cannot open it, and a blob that does not
 * parse — the collector reports that one as `config_invalid` in its own words,
 * and a card inventing a verdict over it would be the second opinion.
 */
export async function credentialNamedAssets(env: IngestEnv): Promise<string[] | null> {
  // Aliased on import: `resolveCredential` is already the name of the
  // service-account BINDING resolver `parseGoogleTargets` takes as a parameter,
  // and two things called that in one file is how a reader loses the thread.
  const credential = await resolveStoredCredential(env, 'google');
  const raw = credential.fields.GOOGLE_SIGNAL_ACCOUNTS;
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  return root === null ? null : blobPropertyAssets(root);
}

/**
 * The Integrations page's answer to *is this credential's own property map
 * still read*, attached to the summary it belongs to (bead `ro-vu8d.22`).
 *
 * THE INGEST REPORTS IT BECAUSE ONLY THE INGEST CAN READ THE BLOB. The Tower
 * derived its own version from `config/integrations.json` alone — the assets
 * that DECLARE a ga4/gsc cell — because it must never see credential contents.
 * That answers a different question, and the two diverge for an ORPHAN: an asset
 * the credential names with no register entry at all. The collector goes on
 * reading `ga4_property_id` for it, correctly; the card said the map answered
 * for none of them, which licenses deleting a value that is still steering a
 * run. What crosses the wire here is asset ids and data-source ids, no more
 * sensitive than what `IntegrationProviderStatus.assets` already carries.
 *
 * Google is the only credential with a map of its own, so it is the only
 * summary that ever gains one; every other provider keeps `propertyMap`
 * absent.
 */
export async function withCredentialPropertyMaps(
  env: IngestEnv,
  state: CredentialStoreState,
  register?: LaneRegister,
): Promise<CredentialStoreState> {
  const google = integrationProvider('google');
  if (google === null) return state;
  const named = await credentialNamedAssets(env);
  const propertyMap = credentialPropertyMapUse(named, google.lanes, register);
  return {
    ...state,
    summaries: state.summaries.map((summary) =>
      summary.provider === 'google' ? { ...summary, propertyMap } : summary,
    ),
  };
}

/** The account name a sign-in collects under, in place of a blob key. */
const GOOGLE_OAUTH_ACCOUNT = 'google-oauth';

/**
 * What the account map is NOT the only way to say any more (bead `ro-vu8d.16`).
 *
 * The operator signs in once on `/integrations`, picks this asset's property on
 * its Sources tab (`ro-vu8d.17`), and that is the whole setup: no JSON blob, no
 * `.dev.vars`, nothing to paste. Every asset the register maps on this lane
 * becomes a target authenticated by the sign-in.
 *
 * `credential_ref` records `google-oauth` rather than the operator's email
 * address: the ledger is asking WHICH credential ran the pull, and an address in
 * every row would be a personal detail stored for a question it does not answer.
 *
 * The day boundary is the OS clock, announced as an assumption exactly like a
 * blob entry that named no `time_zone` — the register does not carry one, and
 * GA4's own `metadata.timeZone` is what the run reads back anyway (`ro-tzq`).
 */
export function registerGoogleTargets(
  oauth: GoogleOAuthGrant,
  source: CredentialSource = 'env',
  register?: LaneRegister,
  assumedTimeZone: string = DEFAULT_GA4_TIME_ZONE,
): GooglePropertyTarget[] {
  const auth: GoogleAuth = { kind: 'oauth', grant: oauth };
  const targets: GooglePropertyTarget[] = [];
  for (const integration of ['ga4', 'gsc'] as const) {
    for (const { asset, ref } of registerMappedAssets(integration, register)) {
      targets.push({
        account: GOOGLE_OAUTH_ACCOUNT,
        asset,
        integration,
        credentialRef: sourcedCredentialRef(GOOGLE_OAUTH_ACCOUNT, source),
        propertyRef: ref,
        timeZone: assumedTimeZone,
        timeZoneAssumed: true,
        auth,
        mappingSource: 'register',
      });
    }
  }
  return targets;
}

export function googleCredentialResolver(env: IngestEnv): GoogleCredentialResolver {
  if (!usesLegacyCredentialBindings(env)) return () => undefined;
  const bindings = env as unknown as Record<string, unknown>;
  return (binding) => {
    const value = bindings[binding];
    return typeof value === 'string' ? value : undefined;
  };
}

async function collectGa4(
  propertyId: string,
  window: SignalDateWindow,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<SignalProviderResult> {
  const response = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: window.start, endDate: window.end }],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'sessions' },
          { name: 'activeUsers' },
          { name: 'screenPageViews' },
          { name: 'eventCount' },
        ],
        keepEmptyRows: true,
        limit: '100',
        // 96 runs a day per property is the heaviest cadence this OS has. Ask
        // what it costs, or a ceiling hit arrives as an ordinary failure.
        returnPropertyQuota: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = await responseJson(response);
  if (!response.ok) throw ga4RequestError(response.status, body);
  const record = asRecord(body);
  const dimensionHeaders = arrayField(record, 'dimensionHeaders');
  const metricHeaders = arrayField(record, 'metricHeaders');
  if (stringField(asRecord(dimensionHeaders[0]), 'name') !== 'date') {
    throw new SignalError('ga4_invalid_response', 'GA4 returned an unexpected date dimension.');
  }
  const metrics = metricHeaders.map((header) => stringField(asRecord(header), 'name'));
  const expected = ['sessions', 'activeUsers', 'screenPageViews', 'eventCount'];
  if (metrics.length !== expected.length || metrics.some((metric, i) => metric !== expected[i])) {
    throw new SignalError('ga4_invalid_response', 'GA4 returned unexpected metric headers.');
  }

  const observations: SignalObservation[] = [];
  const rows = arrayField(record, 'rows');
  for (const rowValue of rows) {
    const row = asRecord(rowValue);
    const dimensions = arrayField(row, 'dimensionValues');
    const values = arrayField(row, 'metricValues');
    const rawDate = stringField(asRecord(dimensions[0]), 'value');
    if (!rawDate || !/^\d{8}$/.test(rawDate) || values.length !== expected.length) {
      throw new SignalError('ga4_invalid_response', 'GA4 returned a malformed daily row.');
    }
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    const names = ['sessions', 'active_users', 'page_views', 'event_count'];
    values.forEach((entry, index) => {
      observations.push({
        date,
        metric: names[index]!,
        value: finiteValue(stringField(asRecord(entry), 'value'), 'GA4'),
      });
    });
  }
  return {
    providerRows: rows.length,
    quota: parseGa4PropertyQuota(record),
    // THE PROPERTY'S OWN ANSWER, on every call the collector already makes
    // (`ro-tzq`). GA4 buckets each event into a day using the property's
    // reporting timezone, and `metadata.timeZone` is that timezone — so the
    // day-definition behind these numbers arrives with the numbers, for free.
    //
    // Read from the provider rather than from config because a configured
    // timezone is a COPY: it is right until somebody changes the property and
    // forgets the secret, and then the OS is confidently wrong about what a
    // "day" is. On 2026-08-31 that is exactly what happened.
    timeZone: stringField(asRecord(record?.metadata), 'timeZone'),
    observations: fillDailyObservations(window, observations, [
      'sessions',
      'active_users',
      'page_views',
      'event_count',
    ]),
    dataState: 'includes-provisional',
    // TODAY AND YESTERDAY are provisional (bead `ro-wo0j`) — see
    // `GA4_SETTLE_DAYS`. Today is a partial day; yesterday is a whole day GA4
    // has not finished attributing. The append-only change log still records
    // every revision; this boundary is what tells a reader not to trust one yet.
    provisionalFrom: ga4ProvisionalFrom(window.end),
  };
}

/**
 * How many calendar days a GA4 day needs before it is settled: a day stays
 * provisional until it has been collected at least once on day D+2 (bead
 * `ro-wo0j`).
 *
 * The Data API states no finalization flag (unlike Search Console's
 * `first_incomplete_date`), so this is a documented delay rather than the
 * provider's answer: docs/02's signal table already says recent GA4 values can
 * be revised for 24–48h, and this portfolio's own evidence set the number —
 * one asset's 2026-09-21, collected at D+1, carried 3,380 "Unassigned"
 * sessions (101–340 on every other September day), 1,321 "Cross-network" (0 on
 * every other day) and Organic Search at 1,096 against Search Console's 1,398
 * Google clicks — while every day collected at D+2 or later read correctly.
 * Two, not more: the D+2 copies were the correct ones, and a longer hold would
 * hide real days. If a D+2 day is ever seen still settling, this is the number
 * to move.
 */
export const GA4_SETTLE_DAYS = 2;

/** The first provisional date for a GA4 collection whose newest day is
 * `windowEnd` (the property's own today). Pure calendar arithmetic on a
 * `YYYY-MM-DD` date, so no clock or zone enters it twice. */
export function ga4ProvisionalFrom(windowEnd: string): string {
  const date = new Date(`${windowEnd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - (GA4_SETTLE_DAYS - 1));
  return formatDate(date);
}

async function collectGsc(
  siteUrl: string,
  window: SignalDateWindow,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<SignalProviderResult> {
  const response = await fetchImpl(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        startDate: window.start,
        endDate: window.end,
        dimensions: ['date'],
        type: 'web',
        dataState: 'all',
        rowLimit: 1000,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = await responseJson(response);
  if (!response.ok) throw providerError('gsc', response.status, body);
  const responseRecord = asRecord(body);
  const rows = arrayField(responseRecord, 'rows');
  const observations: SignalObservation[] = [];
  for (const rowValue of rows) {
    const row = asRecord(rowValue);
    const keys = arrayField(row, 'keys');
    const date = typeof keys[0] === 'string' ? keys[0] : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new SignalError('gsc_invalid_response', 'Search Console returned a malformed daily row.');
    }
    for (const [metric, field] of [
      ['clicks', 'clicks'],
      ['impressions', 'impressions'],
      ['ctr', 'ctr'],
      ['position', 'position'],
    ] as const) {
      observations.push({
        date,
        metric,
        value: finiteValue(row?.[field], 'Search Console'),
      });
    }
  }
  const reportedIncompleteFrom = stringField(
    asRecord(responseRecord?.metadata),
    'first_incomplete_date',
  );
  // A current-day aggregate is partial even when Search Console omits response
  // metadata. If Google reports an earlier incomplete boundary, preserve it.
  const provisionalFrom =
    reportedIncompleteFrom &&
    /^\d{4}-\d{2}-\d{2}$/.test(reportedIncompleteFrom) &&
    reportedIncompleteFrom < window.end
      ? reportedIncompleteFrom
      : window.end;
  return {
    providerRows: rows.length,
    // Search Console reports no timezone because it has none to report: Google
    // fixes its day boundary to Pacific time for every property. Stated
    // here rather than left null, because null means "we do not know" and this
    // is known.
    timeZone: GSC_TIME_ZONE,
    observations: fillDailyObservations(window, observations, [
      'clicks',
      'impressions',
      'ctr',
      'position',
    ]),
    dataState: 'includes-provisional',
    provisionalFrom,
  };
}

function collectionWindow(
  target: Pick<GooglePropertyTarget, 'integration' | 'timeZone'>,
  nowMs: number,
): SignalDateWindow {
  // Search Console's API date contract is PT. GA4 groups the `date` dimension
  // by the property's configured reporting timezone. UTC is therefore not an
  // honest definition of "today" for either provider.
  const timeZone =
    target.integration === 'gsc' ? GSC_TIME_ZONE : target.timeZone;
  const end = dateInTimeZone(nowMs, timeZone);
  const startDate = new Date(`${end}T00:00:00.000Z`);
  startDate.setUTCDate(
    startDate.getUTCDate() - (LIVE_SIGNAL_WINDOW_DAYS - 1),
  );
  return { start: formatDate(startDate), end };
}

function errorOutcome(target: GooglePropertyTarget, error: SignalError): GoogleSignalOutcome {
  return {
    asset: target.asset,
    integration: target.integration,
    status: 'error',
    providerRows: 0,
    observationCount: 0,
    errorCode: error.code,
    mappingSource: target.mappingSource,
  };
}

export function groupGoogleTargetsByAccount(
  targets: GooglePropertyTarget[],
): Map<string, GooglePropertyTarget[]> {
  const grouped = new Map<string, GooglePropertyTarget[]>();
  for (const target of targets) {
    const list = grouped.get(target.account) ?? [];
    list.push(target);
    grouped.set(target.account, list);
  }
  return grouped;
}

/**
 * A GA4 failure, with a quota ceiling told apart from every other 429. A rate
 * limit recovers on its own; an exhausted budget needs an operator, and burying
 * both under `ga4_http_429` is what made a quota crunch invisible.
 */
export function ga4RequestError(status: number, body: unknown): SignalError {
  const generic = providerError('ga4', status, body);
  return isQuotaExhausted(status, body)
    ? new SignalError(GA4_QUOTA_EXHAUSTED_CODE, generic.message)
    : generic;
}

function finiteValue(value: unknown, provider: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new SignalError(
      `${provider === 'GA4' ? 'ga4' : 'gsc'}_invalid_response`,
      `${provider} returned a non-numeric metric value.`,
    );
  }
  return number;
}

function validateTimeZone(timeZone: string, asset: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw new SignalError(
      'config_invalid',
      `Google property "${asset}" has an invalid IANA time_zone.`,
    );
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Daily Search Analytics omits dates with no rows. A bounded date-only query
 * cannot be truncated at 28 rows, so normalize those omissions to honest zeroes
 * and make revisions-to-zero visible in the append-only change log. */
function fillDailyObservations(
  window: SignalDateWindow,
  observations: SignalObservation[],
  metrics: string[],
): SignalObservation[] {
  const values = new Map(
    observations.map((observation) => [
      `${observation.date}\0${observation.metric}`,
      observation.value,
    ]),
  );
  const filled: SignalObservation[] = [];
  for (
    let time = Date.parse(`${window.start}T00:00:00.000Z`);
    time <= Date.parse(`${window.end}T00:00:00.000Z`);
    time += 86_400_000
  ) {
    const date = formatDate(new Date(time));
    for (const metric of metrics) {
      filled.push({ date, metric, value: values.get(`${date}\0${metric}`) ?? 0 });
    }
  }
  return filled;
}
