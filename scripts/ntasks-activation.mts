import { openPlatformProvisioning, type PlatformProvisioning, type PlatformProvisioningOptions } from '../packages/postgres/src/platform-provisioning.mjs';
import type { TaskProjectMapping } from '../packages/postgres/src/task-directory.mjs';

export interface NtasksActivationBinding extends TaskProjectMapping {
  readonly ntasksWorkspaceId: string;
  readonly origin: string;
  readonly serviceToken: string;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const TOKEN = /^ntasks_service\.[A-Za-z0-9._~-]{1,1024}$/u;
const RESPONSE_LIMIT = 128 * 1024;
const TIMEOUT_MS = 5_000;

function refuse(): never { throw new Error('Ntasks project verification refused'); }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function responseObject(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
    await response.body?.cancel();
    refuse();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '', bytes = 0, ended = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { ended = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_LIMIT) refuse();
      body += decoder.decode(chunk.value, { stream: true });
    }
    const parsed = record(JSON.parse(body + decoder.decode()));
    if (!parsed || signal.aborted) refuse();
    return parsed;
  } finally {
    try { if (!ended) await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

/** Bind physical task service verification to deployment-owned directory facts.
 * Enrollment never supplies an address or grants, and verification writes no tasks. */
export function ntasksActivationVerifier(input: NtasksActivationBinding, fetchImpl: typeof fetch = fetch): PlatformProvisioningOptions['verifyProject'] {
  const approved = Object.freeze({ ...input });
  let origin: URL;
  try { origin = new URL(approved.origin); } catch { refuse(); }
  if (origin.origin !== approved.origin || (origin.protocol !== 'https:' && (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'))
    || ![approved.workspaceId, approved.projectId, approved.ntasksWorkspaceId, approved.executorRef, approved.credentialRef].every(id => UUID.test(id))
    || !/^n_[0-9a-f]{32}$/u.test(approved.databaseKey) || !TOKEN.test(approved.serviceToken) || typeof fetchImpl !== 'function') refuse();
  return async (mapping, budget) => {
    if (mapping.workspaceId !== approved.workspaceId || mapping.projectId !== approved.projectId || mapping.executorRef !== approved.executorRef
      || mapping.credentialRef !== approved.credentialRef || mapping.databaseKey !== approved.databaseKey
      || !Number.isFinite(budget.deadline) || budget.signal.aborted) refuse();
    const remaining = Math.floor(Math.min(TIMEOUT_MS, budget.deadline - Date.now()));
    if (remaining <= 0) refuse();
    const signal = AbortSignal.any([budget.signal, AbortSignal.timeout(remaining)]);
    const read = async (path: '/api/access/me' | '/api/tasks/projects') => responseObject(await fetchImpl(approved.origin + path, {
      method: 'GET', redirect: 'manual', signal, headers: { accept: 'application/json', authorization: `Bearer ${approved.serviceToken}`,
        'x-ntasks-workspace': approved.ntasksWorkspaceId },
    }), signal);
    const actor = await read('/api/access/me');
    const grant = Array.isArray(actor.projects) && actor.projects.length === 1 ? record(actor.projects[0]) : null;
    if (actor.kind !== 'service' || grant?.workspaceId !== approved.ntasksWorkspaceId
      || grant.projectId !== approved.projectId || grant.access !== 'write') refuse();
    const catalog = await read('/api/tasks/projects');
    if (!Array.isArray(catalog.projects) || catalog.projects.length !== 1 || record(catalog.projects[0])?.projectId !== approved.projectId) refuse();
    signal.throwIfAborted();
  };
}

/** The operator's existing first-owner flow, with a verified external task project. */
export function openNtasksPlatformProvisioning(options: Omit<PlatformProvisioningOptions, 'verifyProject'>,
  binding: NtasksActivationBinding): PlatformProvisioning {
  return openPlatformProvisioning({ ...options, verifyProject: ntasksActivationVerifier(binding) });
}
