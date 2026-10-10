import { tryHealthConnection } from './integration-health-context.js';
import { beginCollection, collectionMonitoring } from './collection-attempt.js';
// GA4 + Google Search Console collectors. The credential map is
// account-centric: one service-account key can serve several properties, and
// a token is minted once per account + scope. An account entry that names no
// `service_account_b64` authenticates with the operator's sign-in instead, and
// every token goes through `google-auth.ts`. A property saved on an asset's
// Sources tab (the register, `lane-mapping.ts`) beats the credential blob's
// own `properties` map, and `parseGoogleTargets` stops reading the blob's
// property ids on a lane where the register answers for every asset the blob
// names; the blob always keeps the routing and each entry's `time_zone`.

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
  GOOGLE_OAUTH_REVOKED_CODE,
  GOOGLE_OAUTH_REVOKED_MESSAGE,
  GOOGLE_SCOPES,
  decodeServiceAccount,
  googleAccessToken,
  googleAuthCacheKey,
  googleGrantHint,
  isGoogleAuthExpiry,
  providerError,
  responseJson,
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
import { arrayField, asRecord, stringField, utcDay } from './shared.js';

const REQUEST_TIMEOUT_MS = 20_000;
/**
 * The day boundary assumed for a GA4 property whose config entry names no
 * `time_zone`, when the caller has not resolved the saved one: the operator's
 * configured clock, never a literal zone. A guess is announced once per pull
 * (`assumedTimeZoneEvent`); the provider's `metadata.timeZone` is watched
 * separately for the day a property's real boundary moves. Lanes that resolve
 * the store pass its saved zone as `assumedTimeZone`; this is the fallback.
 */
const DEFAULT_GA4_TIME_ZONE = OS_TIME_ZONE;
/**
 * Search Console's day boundary: a real constant, because Google documents
 * every property as reporting in Pacific Time. Declared once, in the provider
 * catalog.
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
  /** True when `timeZone` is the OS clock standing in for a config entry that
   * named none. Kept on the target so the pull can announce it once. */
  timeZoneAssumed: boolean;
  /** The account entry's own service-account key, or the operator's sign-in. */
  auth: GoogleAuth;
  /** The asset's own register entry, or the credential blob's legacy property map. */
  mappingSource: LaneMappingSource;
}

export interface GoogleSignalOutcome {
  asset: string;
  integration: GoogleIntegrationId;
  status: 'success' | 'error';
  providerRows: number;
  observationCount: number;
  errorCode: string | null;
  /** Which mapping this attempt ran on. */
  mappingSource: LaneMappingSource;
  /** The collection failed because the OS's own uplink was down. Still a
   * failure, but no `signal_runs` row and no Health observation accuses the
   * property or Google; the run's one `os-egress-down` flag carries the fact. */
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
  /** Override the compiled-in config/integrations.json mapping (tests). */
  laneRegister?: LaneRegister;
  /** Where this run's config came from, per file; reported on the completion line. */
  configSources?: ConfigSourceMap;
  /** The operator's saved clock, assumed for a GA4 property that states no
   * zone of its own. Absent: the zone compiled into this Worker. */
  osTimeZone?: string;
  /** Override the run's egress gate (tests control the verdict TTL). */
  egress?: EgressGate;
  /** Collect only these assets. Narrower than the schedule, never wider. */
  assets?: readonly string[];
}

type GoogleCredentialResolver = (binding: string) => string | undefined;

export async function runGoogleSignals(
  env: IngestEnv,
  options: GoogleSignalsOptions = {},
): Promise<GoogleSignalsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  // One gate per run, asked only when a Google call came back with no status
  // at all; otherwise one dead token mint writes a `request_failed` row per
  // property. The gate's beacons use the raw fetcher.
  const gate = options.egress ?? new EgressGate(env, { lane: 'google-signals', fetchImpl, at: new Date(nowMs).toISOString() });
  const transport = watchTransport(fetchImpl);
  const googleFetch = transport.fetch;
  // A caller that handed us the raw config is a test: the source is `env`.
  const resolved = await resolveGoogleCredential(env);
  const health = await tryHealthConnection(env, 'google', resolved.credential, [resolved.oauth?.clientId ?? '', resolved.oauth?.clientSecret ?? '']);
  const monitoring = beginCollection(env.STORE, health);
  const source: CredentialSource =
    options.rawConfig === undefined ? resolved.source : 'env';
  const accounts = options.rawConfig ?? resolved.accounts;

  // A property its Data sources row declines (Not using) is not asked for.
  const targets = googleTargets(
    { accounts, oauth: resolved.oauth, connected: resolved.connected },
    source,
    googleCredentialResolver(env),
    options.laneRegister,
    options.osTimeZone,
  ).filter((target) => !laneDeclined(target.asset, target.integration, options.laneRegister)
    && (options.assets === undefined || options.assets.includes(target.asset)));

  // Signed in with nothing mapped anywhere, or not connected at all, is a state
  // to report, not a config error: throwing `config_missing` would put a red
  // lane on a card the operator just connected.
  if (targets.length === 0 && accounts === undefined) {
    console.log(JSON.stringify({
      event: resolved.oauth === null ? 'google_signals_not_connected' : 'google_signals_no_properties_mapped',
    }));
    // Nothing was asked of anyone, so there is no verdict to file either way.
    return { attempted: 0, succeeded: 0, failed: 0, outcomes: [], egress: EGRESS_NOT_ASKED };
  }

  // One line per pull naming the properties whose day boundary was assumed. A
  // wrong assumption shifts which events land on which day, which reads as a
  // chart a few hours out of step. Said here rather than in
  // `parseGoogleTargets`, which runs on every 30-second realtime read.
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
        // When the uplink is what failed, no property was measured and none is blamed.
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
              // property is spent by the rest of the loop.
              accessToken = token;
            },
          );

          // Read the previous timezone before writing this run, or this run
          // becomes its own predecessor and no change is ever visible.
          const priorTimeZone = result.timeZone
            ? await previousTimeZone(env.STORE, target.asset, integration, target.propertyRef)
            : null;

          await recordSignalSuccess(env, target, window, startedAt, result, monitoring);

          // A reporting timezone change means the property's day changed shape
          // and the provider does not reprocess what it already bucketed.
          // Recorded on the timeline; the collection must not fail over it.
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
                // The first day collected under the new boundary.
                effectiveOn: window.end,
              });
            } catch {
              // Never fail a collection over its own bookkeeping; the annotation's
              // identity makes the next run's filing a duplicate.
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
  // One `os-egress-down` fact for the whole run, or the retraction of one an
  // earlier run left open.
  const egress = await gate.finalize();
  // What this run actually measured: a collection the uplink swallowed may not
  // stamp the credential or the property.
  const measured = outcomes.filter((outcome) => !outcome.egressDown);
  // One stamp per pull on the credential, not per property: a property-level
  // failure is the property's story, and a run swallowed whole stamps nothing.
  if (source === 'store' && !(outcomes.length > 0 && measured.length === 0)) {
    const firstError = measured.find((outcome) => outcome.status === 'error');
    // A revoked grant gets its own sentence: it is a statement about the
    // credential, nothing about any property is wrong, and the column has to
    // say what to do rather than name an enum.
    const revoked = measured.every(
      (outcome) =>
        outcome.status !== 'error' || outcome.errorCode === GOOGLE_OAUTH_REVOKED_CODE,
    );
    // Any other failure is one line: the words a site row uses, then how many
    // properties; never the code, which each property's own run keeps.
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
      // `store` means this run read the document an operator saved; `file` the
      // copy compiled into this Worker.
      ...configSourceLine(options.configSources, ['config/integrations.json']),
      // No property ids here: the per-property value is `signal_runs.property_ref`.
      mappingSources: mappingSourceTally(
        outcomes.map((outcome) => outcome.mappingSource),
      ),
      // Provider failures only: an unmeasured collection is never listed as Google's.
      errors: measured
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, integration, errorCode }) => ({ asset, integration, errorCode })),
      unmeasured: outcomes.length - measured.length,
    }),
  );
  return { ...result, egress, ...collectionMonitoring(monitoring) };
}

/**
 * A collection the dead uplink swallowed: noted on the gate and nowhere else.
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
 * Run one provider call, and on a 401 get a fresh token and run it once more.
 * Once, not a loop: a token that expired between minting and using, or an
 * access token invalidated early, is fixed by the second attempt; anything that
 * answers 401 twice is a credential problem. A revoked grant raises
 * `google_oauth_revoked` rather than an HTTP failure, so it propagates as itself.
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
 * The warning, or null when every GA4 property stated its own zone. Built apart
 * from the printing so the suite can pin its shape. GSC targets are excluded:
 * their boundary is Google's documented PT.
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
 * Every Google property this install collects, from both mappings at once: the
 * one door the two Google lanes share. The credential blob's entries are parsed
 * first (with the register overriding each ref it holds), then the register's
 * own mapped assets are added for anything the blob did not cover, so nothing
 * collects twice. Google not connected at all is no work. No blob and no
 * sign-in is still `config_missing` with its old sentence: an install on
 * service accounts must not start reading "sign in" at it. A sign-in with no
 * blob returns whatever the register maps.
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
 * `source` rides into every target's `credentialRef` so `signal_runs` records
 * whether a pull ran on the product's credential or the legacy env one.
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

  // Which halves of this blob are still load-bearing, decided before a single
  // property id is read: where the register answers for every asset the blob
  // names on a lane, `ga4_property_id` / `gsc_site_url` are not read on that
  // lane, so a stale id left in the credential cannot steer anything.
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
    // An entry with no key is fine when the operator has signed in: the grant
    // authenticates its properties. Without a sign-in it is the old error with
    // the old sentence.
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
      // The register first, this blob second, and only while the blob is still
      // somebody's only answer (`credentialAnswers`).
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
 * Every asset the account map names: the keys of each entry's `properties`
 * object, the routing half. Forgiving where the validating pass is strict:
 * answering "named" for a malformed entry only keeps the credential map in
 * play, the conservative side.
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
 * Which assets this install's Google credential names, answered where the blob
 * can be read. `null` means this credential has no property map to talk
 * about (no blob, a key that cannot open it, or a blob that does not parse),
 * and the card then says nothing rather than guessing.
 */
export async function credentialNamedAssets(env: IngestEnv): Promise<string[] | null> {
  // Aliased on import: `resolveCredential` is already the name of the binding
  // resolver `parseGoogleTargets` takes.
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
 * The Integrations page's answer to "is this credential's own property map
 * still read", attached to the summary. The ingest reports it because only the
 * ingest can read the blob; the Tower's own derivation from the register alone
 * diverges for an orphan asset the credential names with no register entry.
 * Google is the only credential with a map of its own.
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
 * Every asset the register maps on a lane becomes a target authenticated by
 * the sign-in: no JSON blob to paste. `credential_ref` records `google-oauth`
 * rather than the operator's email, because the ledger asks which credential
 * ran the pull. The day boundary is the OS clock, announced as an assumption.
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
        // The heaviest cadence this OS has: ask what it costs, or a ceiling hit
        // arrives as an ordinary failure.
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
    // The property's own reporting timezone, on every call: a configured zone
    // is a copy that is right until somebody changes the property.
    timeZone: stringField(asRecord(record?.metadata), 'timeZone'),
    observations: fillDailyObservations(window, observations, [
      'sessions',
      'active_users',
      'page_views',
      'event_count',
    ]),
    dataState: 'includes-provisional',
    // Today and yesterday are provisional (`GA4_SETTLE_DAYS`): today is a
    // partial day; yesterday is a day GA4 has not finished attributing.
    provisionalFrom: ga4ProvisionalFrom(window.end),
  };
}

/**
 * How many calendar days a GA4 day needs before it is settled: a day stays
 * provisional until collected at least once on day D+2. The Data API states no
 * finalization flag, so this is a documented delay; two rather than more
 * because a longer hold would hide real days.
 */
export const GA4_SETTLE_DAYS = 2;

/** The first provisional date for a GA4 collection whose newest day is
 * `windowEnd`. Pure calendar arithmetic, so no clock or zone enters twice. */
export function ga4ProvisionalFrom(windowEnd: string): string {
  const date = new Date(`${windowEnd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - (GA4_SETTLE_DAYS - 1));
  return utcDay(date);
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
  // metadata; an earlier incomplete boundary Google reports is preserved.
  const provisionalFrom =
    reportedIncompleteFrom &&
    /^\d{4}-\d{2}-\d{2}$/.test(reportedIncompleteFrom) &&
    reportedIncompleteFrom < window.end
      ? reportedIncompleteFrom
      : window.end;
  return {
    providerRows: rows.length,
    // Search Console has no timezone to report: Google fixes its day boundary
    // to Pacific time. Stated rather than null, because this is known.
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
  // GSC's date contract is PT; GA4 groups `date` by the property's reporting
  // timezone. UTC is not an honest "today" for either.
  const timeZone =
    target.integration === 'gsc' ? GSC_TIME_ZONE : target.timeZone;
  const end = dateInTimeZone(nowMs, timeZone);
  const startDate = new Date(`${end}T00:00:00.000Z`);
  startDate.setUTCDate(
    startDate.getUTCDate() - (LIVE_SIGNAL_WINDOW_DAYS - 1),
  );
  return { start: utcDay(startDate), end };
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
 * A GA4 failure, with a quota ceiling told apart from every other 429: a rate
 * limit recovers on its own; an exhausted budget needs an operator.
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

/** Daily Search Analytics omits dates with no rows. A bounded date-only query
 * cannot be truncated, so those omissions are honest zeroes. */
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
    const date = utcDay(new Date(time));
    for (const metric of metrics) {
      filled.push({ date, metric, value: values.get(`${date}\0${metric}`) ?? 0 });
    }
  }
  return filled;
}
