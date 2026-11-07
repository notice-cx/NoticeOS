import { portfolioReviewAssetIds, PORTFOLIO_REVIEW_FILE } from '@noticeos/contract/configuration';
import { getConfigDocument } from './config-store.js';
import { PORTFOLIO_BRIEF_ABSTENTION, PORTFOLIO_BRIEF_MAX_BYTES, portfolioBriefEvidenceSchema, type PortfolioBriefEvidence, type PortfolioBriefRead, type PortfolioBriefFailure, type PortfolioBriefRefreshRead } from '@noticeos/contract/portfolio-brief';
import type { WorkflowStepDiagnostics } from '@noticeos/contract';
import { captureWorkflowDiagnostic } from '../../../scripts/workflow-diagnostics.mjs';
import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { resolveCredential, type ResolvedCredential } from './credentials.js';
import { claimLease, releaseLease } from './integration-leases.js';
import { providerCacheScope } from './provider-read-cache.js';
import { generateLocalModel, LocalModelError, localModelFailure, LOCAL_MODEL_ID } from './local-model.js';
import { MODEL_GENERATION_TIMEOUT_MS, portfolioBriefFailure } from '../../../scripts/portfolio-brief-failure.mjs';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { portfolioBriefPrompt } from './portfolio-brief-prompt.js';
import { BriefingResponseError, parsePortfolioBrief, portfolioBriefModelEvidence } from './portfolio-brief-response.js';

const STORAGE_VERSION = '1';
const MIN_FRESHNESS_MS = 15 * 60_000;
const LEASE_MS = MODEL_GENERATION_TIMEOUT_MS + 60_000;

interface StoredBrief extends PortfolioBriefRead { staleAfter: string }
export interface PortfolioBriefOptions {
  clock?: () => number;
  fetchImpl?: typeof fetch;
}

export function emptyPortfolioBrief(state: PortfolioBriefRead['state']): PortfolioBriefRead {
  return { state, briefing: null, lastAttemptAt: null, nextAttemptAt: null, error: null, stale: false };
}

async function reviewSelection(env: IngestEnv) {
  const ids = portfolioReviewAssetIds((await getConfigDocument(env, PORTFOLIO_REVIEW_FILE, {fresh: true})).body);
  return ids === null ? null : [...ids].sort();
}

async function identity(env: IngestEnv, credential: ResolvedCredential, selection: string[] | null) {
  const scope = await providerCacheScope([env.STORE.where, await env.STORE.workspaceId(), STORAGE_VERSION,
    credential.connectionId, credential.revision, credential.fields, selection]);
  return { scope, lease: `portfolio-brief:${scope}` };
}

function presented(stored: StoredBrief | undefined, nowMs: number): PortfolioBriefRead {
  if (!stored) return emptyPortfolioBrief('awaiting');
  const { staleAfter, ...read } = stored;
  return { ...read, stale: read.briefing !== null && (read.error !== null || Date.parse(staleAfter) <= nowMs) };
}

async function stored(env: IngestEnv, scope: string): Promise<StoredBrief | undefined> {
  const [row] = await env.STORE.read(tx => tx.query<{ payload: string }>(
    'SELECT payload FROM noticeos.portfolio_briefings WHERE scope_sha256 = $1 ORDER BY briefing_id DESC LIMIT 1', [scope]));
  return row ? JSON.parse(row.payload) as StoredBrief : undefined;
}

/** This read never asks the model to generate, including after a process restart. */
export async function readPortfolioBrief(env: IngestEnv, options: PortfolioBriefOptions = {}): Promise<PortfolioBriefRead> {
  if (workspaceProfile(env) !== 'standalone') return emptyPortfolioBrief('unsupported');
  try {
    const credential = await resolveCredential(env, 'local-model');
    if (credential.source === 'none') return emptyPortfolioBrief('disconnected');
    const selection = await reviewSelection(env);
    if (selection?.length === 0) return emptyPortfolioBrief('awaiting');
    const { scope } = await identity(env, credential, selection);
    return presented(await stored(env, scope), (options.clock ?? Date.now)());
  } catch {
    return { ...emptyPortfolioBrief('unavailable'), error: 'The saved briefing could not be read.' };
  }
}

/** Explicit refreshes share a lease, so overlapping requests never duplicate model work. */
export async function refreshPortfolioBrief(env: IngestEnv, input: PortfolioBriefEvidence, freshnessMs: number,
  options: PortfolioBriefOptions = {}): Promise<PortfolioBriefRefreshRead> {
  if (workspaceProfile(env) !== 'standalone') return emptyPortfolioBrief('unsupported');
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > PORTFOLIO_BRIEF_MAX_BYTES) throw new Error('Briefing evidence exceeds its limit.');
  const evidence = portfolioBriefEvidenceSchema.parse(input);
  if (!Number.isFinite(freshnessMs) || freshnessMs < MIN_FRESHNESS_MS || freshnessMs > 32 * 86_400_000) throw new Error('Invalid briefing freshness period.');
  const clock = options.clock ?? Date.now;
  const start = clock();
  if (Math.abs(Date.parse(evidence.asOf) - start) > 5 * 60_000) throw new Error('Briefing evidence is not current.');
  const credential = await resolveCredential(env, 'local-model');
  if (credential.source === 'none') return emptyPortfolioBrief('disconnected');
  const selection = await reviewSelection(env);
  const incoming = evidence.reviewAssetIds == null ? null : [...new Set(evidence.reviewAssetIds)].sort();
  if (selection?.length === 0 || JSON.stringify(selection) !== JSON.stringify(incoming)) return emptyPortfolioBrief('awaiting');
  const { scope, lease } = await identity(env, credential, selection);
  let prior = await stored(env, scope);
  const owner = crypto.randomUUID();
  const claim = await claimLease(env.STORE, { key: lease, owner, nowMs: start, expiresAtMs: start + LEASE_MS });
  if (!claim) return presented(prior, start);
  const diagnostics: WorkflowStepDiagnostics = {};
  const token = credential.fields.LOCAL_MODEL_API_TOKEN ?? '';
  const diagnosticOptions = { maxBytes: 65_536, secrets: [token, token.trim()].filter(Boolean) };
  try {
    prior = await stored(env, scope);
    if (JSON.stringify(await reviewSelection(env)) !== JSON.stringify(selection)) return emptyPortfolioBrief('awaiting');
    const eligible = new Set(evidence.insightEvidenceIds);
    const health = eligible.size > 0 ? await tryHealthConnection(env, 'local-model', credential) : null;
    let entry: StoredBrief;
    try {
      const result = eligible.size === 0 ? PORTFOLIO_BRIEF_ABSTENTION : parsePortfolioBrief(await generateLocalModel(env, credential.fields, {
        messages: [{ role: 'system', content: portfolioBriefPrompt() }, { role: 'user', content: portfolioBriefModelEvidence(evidence) }],
        fetchImpl: options.fetchImpl,
        onDiagnostics: (phase, value) => {
          const inputTruncated = phase === 'output' && !!value && typeof value === 'object' && 'truncated' in value && value.truncated === true;
          diagnostics[phase] = captureWorkflowDiagnostic(value, { ...diagnosticOptions, inputTruncated });
        },
      }), evidence);
      const finished = clock();
      entry = { state: 'ready', briefing: { result, generatedAt: new Date(finished).toISOString(), evidenceAsOf: evidence.asOf,
        model: eligible.size > 0 ? credential.fields[LOCAL_MODEL_ID]! : null, sources: evidence.facts.map(({ data: _data, ...source }) => source), limitations: evidence.limitations },
        lastAttemptAt: new Date(start).toISOString(), nextAttemptAt: null, error: null, stale: false,
        staleAfter: new Date(finished + freshnessMs).toISOString() };
      if (eligible.size > 0) await observeIntegration(env, health, { capability: 'portfolio-brief', observedAt: entry.briefing!.generatedAt, ok: true, evidenceSource: 'live' });
    } catch (error) {
      const failure: PortfolioBriefFailure = error instanceof BriefingResponseError ? { kind: error.code }
        : error instanceof LocalModelError && (error.code === 'empty-output' || error.code === 'truncated-output' || error.code === 'reasoning-limit' || error.code === 'refused-output') ? { kind: error.code }
        : error instanceof LocalModelError && error.code === 'invalid-output' ? { kind: 'model-response' } : localModelFailure(error);
      entry = { ...emptyPortfolioBrief('unavailable'), briefing: prior?.briefing ?? null,
        lastAttemptAt: new Date(start).toISOString(), nextAttemptAt: null,
        error: portfolioBriefFailure(failure).summary, failure,
        staleAfter: prior?.staleAfter ?? new Date(start).toISOString() };
      const original = diagnostics.error;
      const classified = captureWorkflowDiagnostic({ kind: failure.kind, message: entry.error,
        ...(original ? { error: original.text } : {}) }, diagnosticOptions);
      diagnostics.error = { ...classified, truncated: classified.truncated || !!original?.truncated,
        redacted: classified.redacted || !!original?.redacted };
      if (eligible.size > 0) await observeIntegration(env, health, { capability: 'portfolio-brief', observedAt: new Date(clock()).toISOString(), ok: false, code: 'provider', evidenceSource: 'live' });
    }
    // A changed or disconnected connection cannot publish its in-flight answer.
    const current = await resolveCredential(env, 'local-model');
    if (current.source === 'none' || (await identity(env, current, await reviewSelection(env))).scope !== scope) return { ...emptyPortfolioBrief('awaiting'),
      ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
    const published = await env.STORE.write(tx => tx.execute(
      `INSERT INTO noticeos.portfolio_briefings (workspace_id, scope_sha256, payload)
       SELECT $1::uuid, $2, $3::jsonb FROM noticeos.integration_leases
        WHERE lease_key = $4 AND owner = $5 AND expires_at > $6::timestamptz`,
      [tx.workspaceId, scope, JSON.stringify(entry), lease, owner, new Date(clock())]));
    if (published !== 1) return { ...presented(await stored(env, scope), clock()), ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
    return { ...presented(entry, clock()), ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
  } finally {
    await releaseLease(env.STORE, lease, owner);
  }
}
