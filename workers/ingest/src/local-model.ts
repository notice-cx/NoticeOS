import type { ConnectionFailure, DiscoverModelProviderInput, DiscoverModelProviderResult } from '@noticeos/contract';
import { PORTFOLIO_BRIEF_MAX_BYTES } from '@noticeos/contract/portfolio-brief';
import { workspaceProfile } from '../../../scripts/product-env.mjs';

export const LOCAL_MODEL_BASE_URL = 'LOCAL_MODEL_BASE_URL';
export const LOCAL_MODEL_ID = 'LOCAL_MODEL_ID';
export const LOCAL_MODEL_API_TOKEN = 'LOCAL_MODEL_API_TOKEN';
const RESPONSE_BYTES = 1_048_576;
// Encoding evidence JSON as a message can double its bytes; reserve space for the prompt, schema and envelope.
const REQUEST_BYTES = 2 * PORTFOLIO_BRIEF_MAX_BYTES + 64 * 1024;
export type LocalModelCode = 'unavailable' | 'configuration' | 'redirect' | 'network' | 'timeout' | 'aborted' | 'access' | 'rate-limit' | 'not-found' | 'model-missing' | 'invalid-output' | 'too-large';
export class LocalModelError extends Error {
  constructor(readonly code: LocalModelCode, readonly status?: number) { super(`OpenAI-compatible model: ${code}.`); this.name = 'LocalModelError'; }
}
export function assertLocalModelAvailable(env: unknown): void {
  if (!env || typeof env !== 'object' || workspaceProfile(env) !== 'standalone') throw new LocalModelError('unavailable');
}
/** Plain HTTP is limited to local address classes; remote providers require TLS. */
function localHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'host.docker.internal') return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1);
    if (address === '::1') return true;
    const head = address.split(':')[0] ?? '';
    if (head.length !== 4) return false;
    const first = Number.parseInt(head, 16);
    return (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf);
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(host)) return false;
  const octets = host.split('.').map(Number);
  const [first, second] = octets;
  return octets.every(value => value >= 0 && value <= 255)
    && (first === 127 || first === 10 || first === 192 && second === 168 || first === 172 && second! >= 16 && second! <= 31);
}
export function localModelBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new LocalModelError('configuration'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol === 'http:' && !localHost(url.hostname))) throw new LocalModelError('configuration');
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url;
}
export interface LocalModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface LocalModelOptions {
  messages: readonly LocalModelMessage[];
  responseSchema: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function request(env: unknown, fields: Record<string, string>, path: string, body: string | undefined,
  fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  assertLocalModelAvailable(env);
  const base = localModelBaseUrl(fields[LOCAL_MODEL_BASE_URL] ?? '');
  if (body && new TextEncoder().encode(body).byteLength > REQUEST_BYTES) throw new LocalModelError('too-large');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const headers = new Headers({ Accept: 'application/json' });
    if (body) headers.set('Content-Type', 'application/json');
    const token = fields[LOCAL_MODEL_API_TOKEN]?.trim();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    // workerd does not support redirect: 'error'; manual handling keeps tokens off redirect destinations.
    const response = await fetchImpl(new URL(path, base), { method: body ? 'POST' : 'GET', headers, body,
      redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new LocalModelError('redirect', response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LocalModelError(response.status === 401 || response.status === 403 ? 'access' : response.status === 429 ? 'rate-limit' : response.status === 404 ? 'not-found' : 'network', response.status);
    }
    if (Number(response.headers.get('content-length')) > RESPONSE_BYTES) { await response.body?.cancel(); throw new LocalModelError('too-large'); }
    const reader = response.body?.getReader();
    if (!reader) throw new LocalModelError('invalid-output');
    let size = 0;
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RESPONSE_BYTES) throw new LocalModelError('too-large');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    try { return JSON.parse(text) as unknown; } catch { throw new LocalModelError('invalid-output'); }
  } catch (error) {
    if (timedOut) throw new LocalModelError('timeout');
    if (signal?.aborted) throw new LocalModelError('aborted');
    if (error instanceof LocalModelError) throw error;
    // workerd does not expose reliable DNS, TLS or refused-connection codes.
    throw new LocalModelError('network');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function localModelFailure(error: unknown): ConnectionFailure {
  if (!(error instanceof LocalModelError)) return { kind: 'network' };
  const kind: ConnectionFailure['kind'] = error.code === 'access' ? 'access'
    : error.code === 'not-found' ? 'not-found' : error.code === 'model-missing' ? 'model-missing'
    : error.code === 'unavailable' ? 'not-supported' : error.code === 'redirect' ? 'redirect' : error.code === 'configuration' ? 'configuration'
    : error.code === 'timeout' ? 'timeout' : error.code === 'rate-limit' ? 'rate-limited'
    : error.code === 'invalid-output' ? 'invalid-response' : error.code === 'too-large' ? 'too-large' : 'network';
  return { kind, ...(error.status === undefined ? {} : { status: error.status }) };
}

/** Discovery does not prove that a listed model can generate structured output. */
export async function discoverLocalModels(env: unknown, input: DiscoverModelProviderInput, fetchImpl: typeof fetch = fetch): Promise<DiscoverModelProviderResult> {
  try {
    const fields = input?.fields;
    if (!object(fields) || Object.entries(fields).some(([key, value]) => ![LOCAL_MODEL_BASE_URL, LOCAL_MODEL_API_TOKEN].includes(key) || typeof value !== 'string' || value.length > 8192)) throw new LocalModelError('configuration');
    const response = await request(env, fields, 'models', undefined, fetchImpl, 10_000);
    if (!object(response) || !Array.isArray(response.data)) throw new LocalModelError('invalid-output');
    if (response.data.length > 1000) throw new LocalModelError('too-large');
    const models: string[] = [];
    for (const row of response.data) {
      if (!object(row) || typeof row.id !== 'string' || row.id.trim().length === 0 || row.id.length > 512 || /[\u0000-\u001f\u007f]/u.test(row.id)) throw new LocalModelError('invalid-output');
      models.push(row.id);
    }
    return { ok: true, models: [...new Set(models)].sort() };
  } catch (error) { return { ok: false, failure: localModelFailure(error) }; }
}

export async function checkLocalModel(env: unknown, fields: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!fields[LOCAL_MODEL_ID]?.trim()) throw new LocalModelError('configuration');
  const response = await request(env, fields, 'models', undefined, fetchImpl, 10_000);
  if (!object(response) || !Array.isArray(response.data)) throw new LocalModelError('invalid-output');
  if (!response.data.some(row => object(row) && row.id === fields[LOCAL_MODEL_ID])) throw new LocalModelError('model-missing');
}

/** The caller validates the returned object against its own domain schema. */
export async function generateLocalModel(env: unknown, fields: Record<string, string>, options: LocalModelOptions): Promise<unknown> {
  if (!fields[LOCAL_MODEL_ID]?.trim()) throw new LocalModelError('configuration');
  const response = await request(env, fields, 'chat/completions', JSON.stringify({ model: fields[LOCAL_MODEL_ID], messages: options.messages,
    stream: false, max_tokens: 4096, temperature: 0.2,
    response_format: { type: 'json_schema', json_schema: { name: 'noticeos_response', strict: true, schema: options.responseSchema } },
  }), options.fetchImpl ?? fetch, 120_000, options.signal);
  if (!object(response) || !Array.isArray(response.choices) || response.choices.length !== 1) throw new LocalModelError('invalid-output');
  const choice: unknown = response.choices[0];
  if (!object(choice) || choice.finish_reason !== 'stop' || !object(choice.message)
      || typeof choice.message.content !== 'string' || choice.message.refusal
      || (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0))) throw new LocalModelError('invalid-output');
  try {
    const value: unknown = JSON.parse(choice.message.content);
    if (!object(value)) throw new LocalModelError('invalid-output');
    return value;
  } catch { throw new LocalModelError('invalid-output'); }
}
