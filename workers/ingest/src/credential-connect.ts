// The connect panel's one press: the typed details are shown to the provider
// with its free read-only call first and stored only when it accepts them, so
// a refused key is never kept and a stored credential keeps working while its
// replacement is judged. Only providers declaring `connect` come through here.
// Same rules as credential-probes.ts: cheapest free read, body read for a
// count and dropped, nothing returned or logged carries a credential, and the
// answer is a verdict plus facts, never the provider's own sentence.

import type {
  ConnectCredentialResult,
  ConnectFacts,
  IntegrationProvider,
  PutCredentialInput,
} from '@noticeos/contract';
import { exactUsd, integrationProvider } from '@noticeos/contract';
import { getBingVerifiedSites } from './bing-client.js';
import { readDataForSeoAccount, recordDataForSeoBalance } from './dataforseo-balance.js';
import { putCredential, recordCredentialOutcome, validateCredentialFields } from './credentials.js';
import { type ProbeFound, probeCalendar, probeDiscord } from './credential-probes.js';
import { connectMediavine } from './mediavine.js';
import { POSTHOG_ACCOUNT_KEY_SLOT, readPosthogAccount } from './posthog-account.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { PROBE_CAPABILITY } from './probe-capability.js';
import { SignalError } from './signal-store.js';
import { CloudflareD1Error, listD1Databases } from './cloudflare-d1-client.js';

/** A person is watching a spinner. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface ConnectOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/** What the provider said about the details, before anything is stored. */
export type CandidateAnswer =
  | { verdict: 'accepted'; facts: ConnectFacts }
  | { verdict: 'refused' }
  | { verdict: 'unreachable' };

/**
 * `ok: true` carries the provider's verdict; `refused` and `unreachable` store
 * nothing. `ok: false` is a request that could not be judged at all.
 */
export async function connectCredential(
  env: IngestEnv,
  input: PutCredentialInput,
  options: ConnectOptions = {},
): Promise<ConnectCredentialResult> {
  const provider = integrationProvider(input.provider);
  if (provider === null) {
    return { ok: false, error: 'unknown_provider', provider: String(input.provider) };
  }
  // A provider whose tokens are pasted per site (Clarity) has no one key to
  // prove; its rows save through `putSiteToken` instead.
  if (provider.connect?.kind !== 'key') {
    return { ok: false, error: 'not_supported', provider: provider.id };
  }
  const raw = input.fields;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: 'validation',
      issues: [{ path: 'fields', code: 'invalid', message: 'fields must be an object of name → value.' }],
    };
  }
  // The store's own rules, BEFORE the provider is asked anything: a field the
  // schema refuses must never leave this Worker, even to its own provider.
  const issues = validateCredentialFields(provider, raw as Record<string, unknown>);
  if (issues.length > 0) return { ok: false, error: 'validation', issues };
  const fields: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = raw[field.name];
    if (typeof value === 'string' && value !== '') fields[field.name] = value;
  }

  // Mediavine's proof is a sign-in, so asking and keeping happen together
  // under its one lease; every other provider is asked, then stored.
  const answer = provider.id === 'mediavine'
    ? await connectMediavine(env, fields, options)
    : await askProvider(provider, fields, options.fetchImpl ?? fetch);
  if ('ok' in answer) return answer;
  const checkedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  if (answer.verdict !== 'accepted') return { ok: true, verdict: answer.verdict, checkedAt };

  if (provider.id !== 'mediavine') {
    const stored = await putCredential(env, { provider: provider.id, fields });
    if (!stored.ok) return stored;
  }
  // The verdict the provider just gave, stamped on the row it proves: the card
  // reads `last_ok_at` as "this credential worked", and it did, a moment ago.
  await recordCredentialOutcome(env, provider.id, { ok: true, error: null, at: checkedAt });
  const credit = exactUsd(answer.facts.creditUsd);
  if (provider.id === 'dataforseo' && credit !== null) {
    await recordDataForSeoBalance(env, credit, checkedAt);
  }
  // The health row the Test button records under, for the connection
  // revision this write created.
  const health = await tryHealthConnection(env, provider.id);
  await observeIntegration(env, health, {
    capability: PROBE_CAPABILITY[provider.id],
    observedAt: checkedAt,
    ok: true,
    code: 'provider',
    evidenceSource: 'probe',
  });
  return { ok: true, verdict: 'accepted', checkedAt, facts: answer.facts };
}

/**
 * Show the details to the provider with its free read-only call, and classify
 * the answer. Never throws: a transport failure is `unreachable`.
 */
export async function askProvider(
  provider: IntegrationProvider,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<CandidateAnswer> {
  if (provider.id === 'cloudflare') {
    try {
      const databases = await listD1Databases(fields, fetchImpl);
      return { verdict: 'accepted', facts: { databases: databases.length, cloudflareD1: { accountId: fields.CLOUDFLARE_ACCOUNT_ID!, databases } } };
    }
    catch (error) { return { verdict: error instanceof CloudflareD1Error && ['access_denied', 'invalid_configuration'].includes(error.code) ? 'refused' : 'unreachable' }; }
  }
  if (provider.id === 'bing-webmaster') return askBing(fields, fetchImpl);
  if (provider.id === 'dataforseo') return askDataForSeo(fields, fetchImpl);
  if (provider.id === 'posthog') return askPosthog(fields, fetchImpl);
  if (provider.id === 'calendar') return fromProbe(() => probeCalendar(fields, withTimeout(fetchImpl)));
  if (provider.id === 'discord') return fromProbe(() => probeDiscord(fields, withTimeout(fetchImpl)));
  // A provider that declares `connect` without a reader here is a catalog
  // change nobody finished; saying "no answer" keeps it from being stored.
  return { verdict: 'unreachable' };
}

/**
 * Calendar feeds and Discord: the Test button's own proof, run before anything
 * is kept. A feed that is not a calendar, or a webhook Discord no longer knows,
 * is a refusal; a timeout, a throttle or a 5xx is no answer.
 */
async function fromProbe(run: () => Promise<ProbeFound>): Promise<CandidateAnswer> {
  let found: ProbeFound;
  try {
    found = await run();
  } catch {
    return { verdict: 'unreachable' };
  }
  const { result } = found;
  if (found.ok) return { verdict: 'accepted', facts: typeof result.facts?.feeds === 'number' ? { feeds: result.facts.feeds } : {} };
  return result.outcome === 'refused' || result.outcome === 'invalid' || result.outcome === 'not-connected'
    ? { verdict: 'refused' }
    : { verdict: 'unreachable' };
}

/** Bing: `GetUserSites`, the call the collector and the Test button open with. */
async function askBing(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<CandidateAnswer> {
  try {
    const sites = await getBingVerifiedSites(fields.BING_WEBMASTER_API_KEY!, withTimeout(fetchImpl));
    return { verdict: 'accepted', facts: { sites: sites.size } };
  } catch (error) {
    return bingRefused(error) ? { verdict: 'refused' } : { verdict: 'unreachable' };
  }
}

/**
 * A refusal is Bing ANSWERING no: a 400/401/403, or a 2xx whose body carries
 * Bing's own error (bing-client.ts names both `bwt_http_<status>`). A timeout,
 * a network failure, a throttle (429) or a 5xx is Bing not answering.
 */
export function bingRefused(error: unknown): boolean {
  if (!(error instanceof SignalError)) return false;
  const status = /^bwt_http_(\d{3})$/.exec(error.code)?.[1];
  if (status === undefined) return false;
  const code = Number(status);
  return (code >= 200 && code < 300) || code === 400 || code === 401 || code === 403;
}

/** DataForSEO: the free account endpoint, which also states the prepaid credit. */
async function askDataForSeo(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<CandidateAnswer> {
  let authorization: string;
  try {
    authorization = `Basic ${btoa(`${fields.DATAFORSEO_LOGIN}:${fields.DATAFORSEO_PASSWORD}`)}`;
  } catch {
    // Characters HTTP Basic cannot carry: no account can be named by them.
    return { verdict: 'refused' };
  }
  try {
    const read = await readDataForSeoAccount(authorization, fetchImpl, CONNECT_TIMEOUT_MS);
    if (read.ok) return { verdict: 'accepted', facts: { creditUsd: read.usd } };
    if (read.reason === 'unauthorized' || read.reason === 'refused') return { verdict: 'refused' };
    return read.status === 403 ? { verdict: 'refused' } : { verdict: 'unreachable' };
  } catch {
    return { verdict: 'unreachable' };
  }
}

/**
 * PostHog: the one personal API key, shown to the US and EU clouds at once;
 * the region that lists its projects is the key's region. Both refusing is a
 * refusal; anything else without an acceptance is no answer.
 */
async function askPosthog(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<CandidateAnswer> {
  const key = fields[POSTHOG_ACCOUNT_KEY_SLOT];
  if (!key) return { verdict: 'refused' };
  const read = await readPosthogAccount(key, fetchImpl, CONNECT_TIMEOUT_MS);
  if (read.verdict !== 'accepted') return { verdict: read.verdict };
  return { verdict: 'accepted', facts: { projects: read.projects.length, region: read.region } };
}

/** Bound Bing's call by the panel's patience rather than the collector's. */
function withTimeout(fetchImpl: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })) as typeof fetch;
}
