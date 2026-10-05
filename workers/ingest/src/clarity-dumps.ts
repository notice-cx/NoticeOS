import { tryHealthConnection } from './integration-health-context.js';
import { beginCollection, collectionMonitoring, type CollectionMonitoring } from './collection-attempt.js';
// Operator-directed Microsoft Clarity behavior-signal collector.
//
// Clarity's Data Export API is the portfolio's hardest-capped provider: **10
// calls per project per DAY**, a trailing 72-hour window only, at most three
// dimensions, and 1,000 rows with no pagination (doc 11, verified 2026-07-04).
// Every property of this lane follows from that cap:
//
//   * ONE call per property per day, archived verbatim to R2 with a manifest
//     row, so every later read is a read of the stored object. Re-analysis must
//     never cost one of the day's ten.
//   * One dimension (URL). A second split is a second call, so it is a separate
//     decision with its own budget, not a free addition.
//   * A property with no configured token is SKIPPED — no call, no manifest row,
//     no error. Absence of a credential is not a failed collection, the same
//     rule the tracked SERP panel follows for an unconfigured property.
//
// Sessions are sampled and `clarity.ms` is on adblock DNS lists (undercounts
// ~15–25%), so these are behavior RANKINGS, not population counts.

import {
  archiveCollectedDump,
  archiveDumpFailure,
  type DumpPage,
  type DumpTarget,
  type SignalDumpOutcome,
} from './signal-dumps.js';
import {
  recordCredentialOutcome,
  resolveCredential,
  sourcedCredentialRef,
} from './credentials.js';
import { normalizeSignalError, SignalError } from './signal-store.js';
import type { WorkspaceStore } from '@noticeos/postgres';
import { SITE_ORDER } from './asset-registry.js';
import { laneDeclined, type LaneRegister } from './lane-mapping.js';
import { failureWords } from './integration-health-store.js';

/** Past this many, a verdict counts the failing sites instead of naming them. */
const NAMED_SITES_MAX = 3;

/**
 * The card's verdict on an export where every site failed: the failure kinds
 * in a site row's words, then the sites — `Access was refused · example.com`.
 */
export function clarityVerdict(failures: readonly { asset: string; errorCode?: string | null }[]): string {
  const sites = [...new Set(failures.map(({ asset }) => asset))];
  const named = sites.length <= NAMED_SITES_MAX ? sites.join(', ') : `${sites.length} sites`;
  return [...failureWords(failures.map(({ errorCode }) => errorCode)), named].join(' · ');
}

const API_URL = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;
/** The provider's documented ceiling per response, with no pagination to reach
 * past it. A block at the cap is explicitly truncated, never "complete". */
const PROVIDER_ROW_CAP = 1_000;
/** Clarity's trailing window. Three days is the whole history the API offers. */
const WINDOW_DAYS = 3;

/**
 * The canonical slot is the per-asset MAP, because Clarity issues a token per
 * project and the portfolio has more than one asset. Since bead `ro-vu8d.9` it
 * is also a CREDENTIAL entered on /integrations: the map is one `asset-map`
 * field in the encrypted `credentials` row, and the binding of the same name is
 * the legacy fallback, exactly as for every other provider.
 *
 * `CLARITY_PROJECT_API_TOKEN` — the single-project shape the operator
 * configured first — is no longer read here at all. It is DECLARED in the
 * provider catalog as this field's `legacyAssetBinding` (bead `ro-vu8d.24`),
 * and `resolveCredential` folds it into the map as that one asset's key. It
 * still gets no form input, so the product teaches only the map; what changed is
 * that the card, this collector and the importer now read it through one rule
 * instead of the collector reading it alone and the card calling the credential
 * missing.
 */
const TOKEN_MAP_SLOT = 'CLARITY_TOKENS';

export const CLARITY_REPORT = 'url-3d';
const REPORT = CLARITY_REPORT;

interface ClarityTarget extends DumpTarget {
  integration: 'clarity';
}

/** One asset's token, and WHICH slot supplied it — so `credential_ref` records
 * the map or the single-project binding truthfully rather than always naming
 * the map. */
interface ClarityToken {
  token: string;
  slot: string;
}

interface PortfolioCandidate {
  asset: string;
  domain: string;
}

export interface ClarityDumpsResult {
  attempted: number;
  succeeded: number;
  unchanged: number;
  failed: number;
  skipped: number;
  outcomes: SignalDumpOutcome[];
}

export interface ClarityDumpsOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** Raw `CLARITY_TOKENS` JSON (tests inject their own). */
  rawTokens?: string;
  /** Asset id → the binding name that supplied its key, for a token folded out
   * of the legacy single-asset binding. Tests inject their own. */
  legacySlots?: Record<string, string>;
  /** `config/integrations.json` as this cron fire read it (store first,
   * dispatch.ts); the compiled copy when absent. Read for the one skip rule
   * every collector applies — Not using (`laneDeclined`, bead
   * `ro-ujb9.96.7.18`). */
  laneRegister?: LaneRegister;
  /** Only these sites — the connect panel's Run now (bead `ro-ujb9.96.7.9`),
   * which spends one of each named site's daily calls and no other's. */
  assets?: readonly string[];
}

export async function runClarityDumps(
  env: IngestEnv,
  options: ClarityDumpsOptions = {},
): Promise<ClarityDumpsResult> {
  const nowMs = options.nowMs ?? Date.now();
  const requestedAt = new Date(nowMs).toISOString();
  // The window is trailing-from-now, so the snapshot is dated by the call, the
  // same way every other provider-snapshot lane is dated.
  const reportDate = requestedAt.slice(0, 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  // STORE FIRST, ENV SECOND (bead `ro-vu8d.9`). `resolveCredential` is the one
  // resolver every provider client goes through, and for Clarity it answers
  // with the whole per-asset map — the same JSON the binding held, so an
  // install on either side of the move behaves identically. Since bead
  // `ro-vu8d.24` it also folds the older single-asset binding into that map and
  // says which asset it answered for, so the manifest below still names the
  // slot that actually held the token.
  const resolved = await resolveCredential(env, 'clarity');
  const health = await tryHealthConnection(env, 'clarity', resolved);
  const monitoring = beginCollection(env.STORE, health);
  const tokens = resolveClarityTokens(
    options.rawTokens ?? resolved.fields[TOKEN_MAP_SLOT],
    options.legacySlots ?? resolved.legacySlots,
  );

  // Declined on its Data sources row (Not using): not asked for, and not
  // counted as a token-less skip either — it is a decision, not a gap.
  const candidates = (await clarityCandidates(env.STORE))
    .filter((candidate) => !laneDeclined(candidate.asset, 'clarity', options.laneRegister))
    .filter((candidate) => options.assets === undefined || options.assets.includes(candidate.asset));
  const outcomes: SignalDumpOutcome[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const held = tokens.get(candidate.asset);
    if (!held) {
      // Documented silent skip. An error row per asset per day would be an
      // alarm about a decision the operator already made.
      skipped += 1;
      continue;
    }
    outcomes.push(
      await collectProject(
        env,
        clarityTarget(candidate, sourcedCredentialRef(held.slot, resolved.source)),
        held.token,
        reportDate,
        requestedAt,
        fetchImpl,
        monitoring,
      ),
    );
  }

  const result = {
    attempted: outcomes.length,
    succeeded: outcomes.filter((outcome) => outcome.status === 'success').length,
    unchanged: outcomes.filter((outcome) => outcome.status === 'unchanged').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    skipped,
    outcomes,
  };

  // THE COLLECTOR IS THE PROOF (bead `ro-vu8d.9`). Clarity's card has no Test
  // button that calls Clarity — there is no free call to make — so this run is
  // the only thing that can ever put a verdict on it. A run where SOMETHING
  // answered is a working credential; a run where every attempt failed is the
  // sentence the operator needs, and the codes are the ingest's own so the card
  // and the log cannot describe one failure two ways.
  if (resolved.source === 'store' && result.attempted > 0) {
    const failures = outcomes.filter((outcome) => outcome.status === 'error');
    await recordCredentialOutcome(env, 'clarity', {
      ok: failures.length < result.attempted,
      // One line (bead `ro-ujb9.96.6.31`): what went wrong in the site row's
      // words, then which sites — each has its own token, so the site is what
      // the operator fixes. The codes stay in the log line below.
      error: failures.length === 0 ? null : clarityVerdict(failures),
      at: requestedAt,
    });
  }
  console.log(
    JSON.stringify({
      event: 'clarity_dumps_complete',
      attempted: result.attempted,
      succeeded: result.succeeded,
      unchanged: result.unchanged,
      failed: result.failed,
      // Named so an all-skipped run reads as "no property is configured",
      // never as "the lane ran clean".
      skippedNoToken: result.skipped,
      errors: outcomes
        .filter((outcome) => outcome.status === 'error')
        .map(({ asset, report, errorCode }) => ({ asset, report, errorCode })),
    }),
  );
  return { ...result, ...collectionMonitoring(monitoring) };
}

/**
 * Asset → project token, out of the one map the resolver answered with.
 *
 * `legacySlots` names the assets whose key came from the older single-asset
 * binding rather than from the map itself, so `credential_ref` records the slot
 * that actually held it. The precedence question the two shapes used to raise is
 * settled upstream, in the contract: the map wins wherever both name an asset.
 */
export function resolveClarityTokens(
  rawMap: string | undefined,
  legacySlots: Record<string, string>,
): Map<string, ClarityToken> {
  const tokens = new Map<string, ClarityToken>();
  if (!rawMap || rawMap.trim().length === 0) return tokens;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMap);
  } catch {
    throw new SignalError(
      'config_invalid',
      `${TOKEN_MAP_SLOT} is not valid JSON.`,
    );
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new SignalError(
      'config_invalid',
      `${TOKEN_MAP_SLOT} must be a JSON object of asset id to project token.`,
    );
  }
  for (const [asset, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SignalError(
        'config_invalid',
        `${TOKEN_MAP_SLOT}["${asset}"] must be a non-empty project token.`,
      );
    }
    tokens.set(asset, { token: value.trim(), slot: legacySlots[asset] ?? TOKEN_MAP_SLOT });
  }
  return tokens;
}

/** The launched sites with a domain, from the site list on Postgres (bead
 * ro-ujb9.76.4.2). */
export async function clarityCandidates(store: WorkspaceStore): Promise<PortfolioCandidate[]> {
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

function clarityTarget(candidate: PortfolioCandidate, credentialRef: string): ClarityTarget {
  return {
    asset: candidate.asset,
    integration: 'clarity',
    // Which SLOT held the token, never the token — `store:`-prefixed when the
    // product's credential ran the pull, so "is this asset still on .dev.vars"
    // is a fact you read rather than assume.
    credentialRef,
    propertyRef: candidate.domain,
  };
}

async function collectProject(
  env: IngestEnv,
  target: ClarityTarget,
  token: string,
  reportDate: string,
  requestedAt: string,
  fetchImpl: typeof fetch,
  monitoring?: CollectionMonitoring,
): Promise<SignalDumpOutcome> {
  const query = new URLSearchParams({
    numOfDays: String(WINDOW_DAYS),
    dimension1: 'URL',
  });
  try {
    const response = await fetchImpl(`${API_URL}?${query}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await boundedResponseJson(response);
    if (!response.ok) throw clarityProviderError(response.status, body);

    const blocks = Array.isArray(body) ? body : [];
    if (blocks.length === 0) {
      // The daily call was spent and answered with nothing recognizable. That
      // is a failed observation, not a property with no behavior.
      throw new SignalError(
        'clarity_invalid_response',
        'Clarity returned no metric blocks.',
      );
    }
    const counts = blocks.map(
      (block) => arrayField(asRecord(block), 'information').length,
    );
    const page: DumpPage = {
      // The exact question, archived beside the answer. Never the token.
      request: { url: `${API_URL}?${query}`, numOfDays: WINDOW_DAYS, dimension1: 'URL' },
      response: body,
    };
    return await archiveCollectedDump(env, {
      monitoring,
      provider: 'microsoft',
      target,
      report: REPORT,
      reportDate,
      requestedAt,
      dataState: 'provider-snapshot',
      collected: {
        pages: [page],
        providerRows: counts.reduce((sum, count) => sum + count, 0),
        // No pagination exists to reach past the cap, so a block sitting on it
        // is a floor on the truth, not the truth.
        providerTruncated: counts.some((count) => count >= PROVIDER_ROW_CAP),
      },
    });
  } catch (error) {
    const normalized = normalizeSignalError(error, 'Clarity export failed.');
    return archiveDumpFailure(env.STORE, {
      monitoring,
      target,
      report: REPORT,
      reportDate,
      requestedAt,
      dataState: 'provider-snapshot',
      error: normalized,
    });
  }
}

/** 401/403 is the token; 402/429 is the 10-a-day cap. They are different
 * operator actions, so they get different codes. */
function clarityProviderError(status: number, body: unknown): SignalError {
  const record = asRecord(body);
  const message =
    stringField(record, 'message') ??
    stringField(record, 'error') ??
    `Clarity returned HTTP ${status}.`;
  if (status === 401 || status === 403) {
    return new SignalError(
      'clarity_token_rejected',
      `Clarity rejected the project token (HTTP ${status}). ${message}`.slice(0, 500),
    );
  }
  if (status === 402 || status === 429) {
    return new SignalError(
      'clarity_daily_cap_reached',
      `Clarity refused the call within its 10-per-project-per-day cap (HTTP ${status}). ${message}`.slice(
        0,
        500,
      ),
    );
  }
  return new SignalError(`clarity_http_${status}`, message.slice(0, 500));
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_BYTE_LIMIT) {
    await response.body?.cancel();
    throw new SignalError(
      'response_too_large',
      `Clarity response exceeded ${RESPONSE_BYTE_LIMIT} bytes.`,
    );
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_BYTE_LIMIT) {
        await reader.cancel();
        throw new SignalError(
          'response_too_large',
          `Clarity response exceeded ${RESPONSE_BYTE_LIMIT} bytes.`,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SignalError('response_invalid_json', 'Clarity returned invalid JSON.');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function arrayField(
  record: Record<string, unknown> | null,
  field: string,
): unknown[] {
  const value = record?.[field];
  return Array.isArray(value) ? value : [];
}
