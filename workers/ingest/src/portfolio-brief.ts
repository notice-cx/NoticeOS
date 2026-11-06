import { PORTFOLIO_BRIEF_ABSTENTION, PORTFOLIO_BRIEF_MAX_BYTES, portfolioBriefResponseSchema, portfolioBriefEvidenceSchema, portfolioBriefResultSchema, type PortfolioBriefEvidence, type PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { resolveCredential, type ResolvedCredential } from './credentials.js';
import { claimLease, releaseLease } from './integration-leases.js';
import { providerCacheScope } from './provider-read-cache.js';
import { generateLocalModel, LocalModelError, LOCAL_MODEL_ID } from './local-model.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { PORTFOLIO_BRIEF_PROMPT } from './portfolio-brief-prompt.js';

const VERSION = '3';
const MIN_REFRESH_MS = 15 * 60_000;
const LEASE_MS = 3 * 60_000;
const FAILURE_RETRY_MS = 15 * 60_000;

interface StoredBrief extends PortfolioBriefRead { staleAfter: string }
export interface PortfolioBriefOptions {
  cache?: Cache;
  clock?: () => number;
  fetchImpl?: typeof fetch;
}

export function emptyPortfolioBrief(state: PortfolioBriefRead['state']): PortfolioBriefRead {
  return { state, briefing: null, lastAttemptAt: null, nextAttemptAt: null, error: null, stale: false };
}

async function identity(env: IngestEnv, credential: ResolvedCredential) {
  const scope = await providerCacheScope([env.STORE.where, await env.STORE.workspaceId(), VERSION,
    credential.connectionId, credential.revision, credential.fields]);
  return { key: `https://noticeos-cache.internal/portfolio-brief/${scope}`, lease: `portfolio-brief:${scope}` };
}

function presented(stored: StoredBrief | undefined, nowMs: number): PortfolioBriefRead {
  if (!stored) return emptyPortfolioBrief('awaiting');
  const { staleAfter, ...read } = stored;
  return { ...read, stale: read.briefing !== null && (read.error !== null || Date.parse(staleAfter) <= nowMs) };
}

async function cached(cache: Cache, key: string): Promise<StoredBrief | undefined> {
  const response = await cache.match(key);
  return response ? response.json<StoredBrief>() : undefined;
}

/** This read never asks the model to generate, even with an empty cache. */
export async function readPortfolioBrief(env: IngestEnv, options: PortfolioBriefOptions = {}): Promise<PortfolioBriefRead> {
  if (workspaceProfile(env) !== 'standalone') return emptyPortfolioBrief('unsupported');
  try {
    const credential = await resolveCredential(env, 'local-model');
    if (credential.source === 'none') return emptyPortfolioBrief('disconnected');
    const { key } = await identity(env, credential);
    return presented(await cached(options.cache ?? caches.default, key), (options.clock ?? Date.now)());
  } catch {
    return { ...emptyPortfolioBrief('unavailable'), error: 'The saved briefing could not be read.' };
  }
}

/** The scheduler owns generation; the lease also bounds manual workflow runs. */
export async function refreshPortfolioBrief(env: IngestEnv, input: PortfolioBriefEvidence, cadenceMs: number,
  options: PortfolioBriefOptions = {}): Promise<PortfolioBriefRead> {
  if (workspaceProfile(env) !== 'standalone') return emptyPortfolioBrief('unsupported');
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > PORTFOLIO_BRIEF_MAX_BYTES) throw new Error('Briefing evidence exceeds its limit.');
  const evidence = portfolioBriefEvidenceSchema.parse(input);
  if (!Number.isFinite(cadenceMs) || cadenceMs < MIN_REFRESH_MS || cadenceMs > 32 * 86_400_000) throw new Error('Invalid briefing cadence.');
  const clock = options.clock ?? Date.now;
  const start = clock();
  if (Math.abs(Date.parse(evidence.asOf) - start) > 5 * 60_000) throw new Error('Briefing evidence is not current.');
  const credential = await resolveCredential(env, 'local-model');
  if (credential.source === 'none') return emptyPortfolioBrief('disconnected');
  const { key, lease } = await identity(env, credential);
  const cache = options.cache ?? caches.default;
  let prior = await cached(cache, key);
  if (prior?.nextAttemptAt && Date.parse(prior.nextAttemptAt) > start) return presented(prior, start);
  const owner = crypto.randomUUID();
  const claim = await claimLease(env.STORE, { key: lease, owner, nowMs: start, expiresAtMs: start + LEASE_MS,
    takeoverAlso: { sql: '(l.cooldown_until IS NULL OR l.cooldown_until <= $5::timestamptz OR $6::boolean)', param: false } });
  if (!claim) return presented(prior, start);
  let nextAttemptAt: string | null = null;
  try {
    prior = await cached(cache, key);
    if (prior?.nextAttemptAt && Date.parse(prior.nextAttemptAt) > clock()) return presented(prior, clock());
    const eligible = new Set(evidence.insightEvidenceIds);
    const health = eligible.size > 0 ? await tryHealthConnection(env, 'local-model', credential) : null;
    let entry: StoredBrief;
    try {
      const raw = eligible.size === 0 ? PORTFOLIO_BRIEF_ABSTENTION : await generateLocalModel(env, credential.fields, {
        messages: [{ role: 'system', content: PORTFOLIO_BRIEF_PROMPT }, { role: 'user', content: JSON.stringify(evidence) }],
        responseSchema: portfolioBriefResponseSchema, fetchImpl: options.fetchImpl,
      });
      const result = portfolioBriefResultSchema.parse(raw);
      const known = new Set(evidence.facts.map(fact => fact.id));
      if (result.insights.some(insight => insight.evidenceIds.some(id => !known.has(id)) || !insight.evidenceIds.some(id => eligible.has(id)))) throw new LocalModelError('invalid-output');
      const finished = clock();
      nextAttemptAt = new Date(start + MIN_REFRESH_MS).toISOString();
      entry = { state: 'ready', briefing: { result, generatedAt: new Date(finished).toISOString(), evidenceAsOf: evidence.asOf,
        model: eligible.size > 0 ? credential.fields[LOCAL_MODEL_ID]! : null, sources: evidence.facts.map(({ data: _data, ...source }) => source), limitations: evidence.limitations },
        lastAttemptAt: new Date(start).toISOString(), nextAttemptAt, error: null, stale: false,
        staleAfter: new Date(start + cadenceMs * 2).toISOString() };
      if (eligible.size > 0) await observeIntegration(env, health, { capability: 'portfolio-brief', observedAt: entry.briefing!.generatedAt, ok: true, evidenceSource: 'live' });
    } catch (error) {
      nextAttemptAt = new Date(clock() + FAILURE_RETRY_MS).toISOString();
      entry = { ...emptyPortfolioBrief('unavailable'), briefing: prior?.briefing ?? null,
        lastAttemptAt: new Date(start).toISOString(), nextAttemptAt,
        error: error instanceof LocalModelError && error.code === 'timeout' ? 'The model took too long to respond.'
          : error instanceof LocalModelError && error.code !== 'invalid-output' ? 'The local model could not complete the briefing.'
          : 'The model response did not pass the briefing checks.',
        staleAfter: prior?.staleAfter ?? new Date(start).toISOString() };
      if (eligible.size > 0) await observeIntegration(env, health, { capability: 'portfolio-brief', observedAt: new Date(clock()).toISOString(), ok: false, code: 'provider', evidenceSource: 'live', nextAttemptAt });
    }
    // A changed or disconnected connection cannot publish its in-flight answer.
    const current = await resolveCredential(env, 'local-model');
    if (current.source === 'none' || (await identity(env, current)).key !== key) return emptyPortfolioBrief('awaiting');
    const retentionSeconds = Math.max(7 * 86_400, Math.ceil(cadenceMs * 2 / 1_000));
    await cache.put(key, Response.json(entry, { headers: { 'cache-control': `max-age=${retentionSeconds}` } }));
    return presented(entry, clock());
  } finally {
    const cooldownUntil = nextAttemptAt;
    if (cooldownUntil) await env.STORE.write(tx => tx.execute(
      'UPDATE noticeos.integration_leases SET cooldown_until = $1::timestamptz WHERE lease_key = $2 AND owner = $3', [new Date(cooldownUntil), lease, owner]));
    await releaseLease(env.STORE, lease, owner);
  }
}
