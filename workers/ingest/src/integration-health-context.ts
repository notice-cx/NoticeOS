import type { IntegrationProviderId, IntegrationHealthScope } from '@noticeos/contract';
import { assertCredentialOwner, credentialSummary, resolveCredential, usesLegacyCredentialBindings, type ResolvedCredential } from './credentials.js';
import { healthFailure, healthId, tryRecordIntegrationObservation } from './integration-health-store.js';

export interface HealthConnection { workspaceId: string; connectionId: string | null; provider: IntegrationProviderId; revision: string; configured: boolean; changedAt: string | null }
/** Capture before calling the provider. Stored credentials have a stable edit
 * revision (session renewal and key resealing do not change updatedAt). Legacy
 * values get a server-only fingerprint; no credential-derived ID is exposed by
 * the public health payload. */
export async function healthConnection(env: IngestEnv, provider: IntegrationProviderId, resolved?: ResolvedCredential, googleAppSnapshot?: readonly string[]): Promise<HealthConnection> {
  if (resolved) await assertCredentialOwner(env, resolved, provider);
  const workspaceId = await env.STORE.workspaceId();
  const summary = await credentialSummary(env, provider);
  const credential = resolved ?? await resolveCredential(env, provider);
  if (summary?.source === 'store' && credential.source !== 'store') throw new Error('Monitoring connection could not be resolved');
  if (credential.source === 'store' && !credential.revision) throw new Error('Monitoring connection revision is missing');
  let dependencies: unknown[] = [];
  if (provider === 'google') {
    const accounts: unknown = credential.fields.GOOGLE_SIGNAL_ACCOUNTS ? JSON.parse(credential.fields.GOOGLE_SIGNAL_ACCOUNTS) : {};
    if (accounts && typeof accounts === 'object') dependencies = Object.values(accounts).flatMap(value => {
      if (!value || typeof value !== 'object' || !('service_account_binding' in value) || typeof value.service_account_binding !== 'string') return [];
      if (!usesLegacyCredentialBindings(env)) throw new Error('Legacy Google bindings require a standalone installation');
      return [[value.service_account_binding, (env as unknown as Record<string, unknown>)[value.service_account_binding] ?? null]];
    });
    if (credential.fields.GOOGLE_OAUTH_REFRESH_TOKEN) {
      const app = googleAppSnapshot;
      if (app) dependencies.push(app);
      else { const appCredential = await resolveCredential(env, 'google-oauth-app'); dependencies.push([appCredential.fields.GOOGLE_OAUTH_CLIENT_ID ?? '', appCredential.fields.GOOGLE_OAUTH_CLIENT_SECRET ?? '']); }
    }
  }
  const parts = [credential.source === 'store'
    ? ['store', provider, credential.revision?.createdAt, credential.revision?.updatedAt]
    : ['legacy', provider, Object.entries(credential.fields).filter(([key]) => key !== 'MEDIAVINE_SESSION').sort(([a], [b]) => a.localeCompare(b))], dependencies];
  // Preserve existing standalone revisions so its stored monitoring history
  // remains usable. Hosted revisions include the actual connection identity.
  const revision = await healthId(usesLegacyCredentialBindings(env) ? parts : [workspaceId, credential.connectionId, parts]);
  return { workspaceId, connectionId: credential.connectionId, provider, revision, configured: credential.source !== 'none', changedAt: credential.revision?.updatedAt ?? null };
}
export async function tryHealthConnection(env: IngestEnv, provider: IntegrationProviderId, resolved?: ResolvedCredential, googleAppSnapshot?: readonly string[]): Promise<HealthConnection | null> {
  try { return await healthConnection(env, provider, resolved, googleAppSnapshot); }
  catch { return null; }
}
export async function healthScope(connection: HealthConnection, capability: string, asset = '', target = '', family = ''): Promise<IntegrationHealthScope> {
  return { workspace: connection.workspaceId, provider: connection.provider, connection: connection.revision, capability, asset, target: target ? await healthId(target) : '', family };
}
export async function observeIntegration(env: IngestEnv, connection: HealthConnection | null, input: {
  capability: string; asset?: string; target?: string; family?: string; observedAt: string;
  ok: boolean; code?: unknown; nextAttemptAt?: string | null; attemptId?: string; evidenceSource?: 'live' | 'calendar' | 'delivery' | 'probe' | 'mediavine_runs';
}): Promise<boolean> {
  if (!connection) return false;
  try {
  if (connection.workspaceId !== await env.STORE.workspaceId()) return false;
  // Discovery clients may resolve their credentials internally. If the edit
  // revision changed during the operation, do not assign its result to either
  // connection. The new connection remains unverified.
  const current = await tryHealthConnection(env, connection.provider);
  if (!current || current.workspaceId !== connection.workspaceId || current.connectionId !== connection.connectionId || current.revision !== connection.revision) return false;
  const scope = await healthScope(connection, input.capability, input.asset, input.target, input.family);
  const failure = input.ok ? null : healthFailure(input.code);
  return await tryRecordIntegrationObservation(env.STORE, { scope, attemptId: input.attemptId ?? await healthId([scope, input.observedAt]), startedAt: input.observedAt,
    // These adapters report an observation instant, not a measured duration.
    finishedAt: input.observedAt, outcome: input.ok ? 'success' : 'failure', failure: failure?.failure ?? null, code: failure?.code ?? null,
    nextAttemptAt: input.nextAttemptAt ?? null, evidenceSource: input.evidenceSource ?? 'live', evidenceId: input.attemptId ?? input.observedAt });
  } catch { return false; }
}
