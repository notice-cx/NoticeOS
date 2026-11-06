import type { ConnectionFailure, DiscoverModelProviderInput, DiscoverModelProviderResult } from '@noticeos/contract';
import { LOCAL_MODEL_OUTPUT_TOKENS, parseLocalModelOutputTokens } from '@noticeos/contract/local-model-settings';
import { MODEL_GENERATION_TIMEOUT_MS } from '../../../scripts/portfolio-brief-failure.mjs';
import { PORTFOLIO_BRIEF_MAX_BYTES } from '@noticeos/contract/portfolio-brief';
import { workspaceProfile } from '../../../scripts/product-env.mjs';

export const LOCAL_MODEL_BASE_URL = 'LOCAL_MODEL_BASE_URL';
export const LOCAL_MODEL_ID = 'LOCAL_MODEL_ID';
export const LOCAL_MODEL_API_TOKEN = 'LOCAL_MODEL_API_TOKEN';
const RESPONSE_BYTES = 1_048_576;
const DIAGNOSTIC_BYTES = 65_536;
// Encoding evidence JSON as a message can double its bytes; reserve space for the prompt and envelope.
const REQUEST_BYTES = 2 * PORTFOLIO_BRIEF_MAX_BYTES + 64 * 1024;
export type LocalModelCode = 'unavailable' | 'configuration' | 'redirect' | 'network' | 'timeout' | 'aborted' | 'access' | 'rate-limit' | 'not-found' | 'model-missing' | 'invalid-output' | 'empty-output' | 'truncated-output' | 'refused-output' | 'reasoning-limit' | 'too-large';
export class LocalModelError extends Error {
  constructor(readonly code: LocalModelCode, readonly status?: number) { super(`OpenAI-compatible model: ${code}.`); this.name = 'LocalModelError'; }
}
export function assertLocalModelAvailable(env: unknown): void {
  if (!env || typeof env !== 'object' || workspaceProfile(env) !== 'standalone') throw new LocalModelError('unavailable');
}
/** Plain HTTP is limited to local address classes; remote providers require TLS. */
export function isLocalAddress(hostname: string): boolean {
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
      || (url.protocol === 'http:' && !isLocalAddress(url.hostname))) throw new LocalModelError('configuration');
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url;
}
export interface LocalModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface LocalModelOptions {
  messages: readonly LocalModelMessage[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onDiagnostics?: (phase: 'input' | 'output' | 'error', value: unknown) => void;
}
function diagnose(callback: LocalModelOptions['onDiagnostics'], phase: 'input' | 'output' | 'error', value: unknown): void {
  try { callback?.(phase, value); } catch { /* Diagnostics cannot change a model verdict. */ }
}
function transportError(error: unknown): { name: string; message: string; cause?: { name: string; message: string } } {
  try {
    if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
    const cause = error.cause;
    return { name: error.name, message: error.message,
      ...(cause === undefined ? {} : { cause: cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : { name: object(cause) && typeof cause.name === 'string' ? cause.name : 'Error',
          message: typeof cause === 'string' ? cause
            : object(cause) && typeof cause.message === 'string' ? cause.message : 'Non-text error cause' } }) };
  } catch { return { name: 'Error', message: 'Model transport error details could not be read.' }; }
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function request(env: unknown, fields: Record<string, string>, path: string, body: string | undefined,
  fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal, onDiagnostics?: LocalModelOptions['onDiagnostics']): Promise<unknown> {
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
    if (body) diagnose(onDiagnostics, 'input', body);
    // workerd does not support redirect: 'error'; manual handling keeps tokens off redirect destinations.
    const response = await fetchImpl(new URL(path, base), { method: body ? 'POST' : 'GET', headers, body,
      redirect: 'manual', signal: controller.signal });
    const failure = response.status >= 300 && response.status < 400 ? new LocalModelError('redirect', response.status)
      : !response.ok ? new LocalModelError(response.status === 401 || response.status === 403 ? 'access' : response.status === 429 ? 'rate-limit' : response.status === 404 ? 'not-found' : 'network', response.status) : null;
    if (failure && !onDiagnostics) { await response.body?.cancel(); throw failure; }
    const oversizedHeader = Number(response.headers.get('content-length')) > RESPONSE_BYTES;
    if (oversizedHeader && !onDiagnostics) { await response.body?.cancel(); throw new LocalModelError('too-large'); }
    const reader = response.body?.getReader();
    if (!reader) {
      diagnose(onDiagnostics, 'output', { status: response.status, body: '', truncated: false });
      throw failure ?? new LocalModelError('invalid-output');
    }
    let size = 0;
    const decoder = new TextDecoder();
    let text = '', diagnosticSize = 0, diagnosticTruncated = false;
    const diagnosticChunks: Uint8Array[] = [];
    const limit = failure || oversizedHeader ? DIAGNOSTIC_BYTES : RESPONSE_BYTES;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (onDiagnostics) {
          const kept = value.subarray(0, Math.max(0, DIAGNOSTIC_BYTES - diagnosticSize));
          if (kept.byteLength) diagnosticChunks.push(kept.slice());
          diagnosticSize += kept.byteLength;
          if (kept.byteLength < value.byteLength) diagnosticTruncated = true;
        }
        size += value.byteLength;
        if (size > limit) {
          diagnosticTruncated = true;
          if (failure || oversizedHeader) break;
          throw new LocalModelError('too-large');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      diagnosticTruncated = true;
      if (failure) diagnose(onDiagnostics, 'error', transportError(error));
      if (!failure) throw error;
    } finally {
      await reader.cancel().catch(() => undefined); reader.releaseLock();
      if (onDiagnostics) {
        const captured = new Uint8Array(diagnosticSize); let offset = 0;
        for (const chunk of diagnosticChunks) { captured.set(chunk, offset); offset += chunk.byteLength; }
        // An incomplete final UTF-8 character is omitted, never expanded past the byte cap.
        const body = new TextDecoder().decode(captured, { stream: diagnosticTruncated });
        diagnose(onDiagnostics, 'output', { status: response.status, body, truncated: diagnosticTruncated });
      }
    }
    if (failure) throw failure;
    if (oversizedHeader) throw new LocalModelError('too-large');
    try { return JSON.parse(text) as unknown; } catch { throw new LocalModelError('invalid-output'); }
  } catch (error) {
    if (!(error instanceof LocalModelError)) diagnose(onDiagnostics, 'error', transportError(error));
    if (error instanceof LocalModelError && error.status !== undefined) throw error;
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
    : ['invalid-output', 'empty-output', 'truncated-output', 'refused-output', 'reasoning-limit'].includes(error.code) ? 'invalid-response' : error.code === 'too-large' ? 'too-large' : 'network';
  return { kind, ...(error.status === undefined ? {} : { status: error.status }) };
}

/** Discovery does not prove that a listed model can complete a generation request. */
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

/** Only the server's final answer is returned; reasoning and tool calls are never an answer. */
export async function generateLocalModel(env: unknown, fields: Record<string, string>, options: LocalModelOptions): Promise<string> {
  if (!fields[LOCAL_MODEL_ID]?.trim()) throw new LocalModelError('configuration');
  const outputTokens = parseLocalModelOutputTokens(fields[LOCAL_MODEL_OUTPUT_TOKENS]);
  if (outputTokens === null) throw new LocalModelError('configuration');
  const response = await request(env, fields, 'chat/completions', JSON.stringify({ model: fields[LOCAL_MODEL_ID], messages: options.messages,
    stream: false, max_tokens: outputTokens,
  }), options.fetchImpl ?? fetch, MODEL_GENERATION_TIMEOUT_MS, options.signal, options.onDiagnostics);
  if (!object(response) || !Array.isArray(response.choices) || response.choices.length !== 1) throw new LocalModelError('invalid-output');
  const choice: unknown = response.choices[0];
  if (!object(choice) || !object(choice.message)) throw new LocalModelError('invalid-output');
  if (choice.finish_reason === 'content_filter' || choice.message.refusal) throw new LocalModelError('refused-output');
  if (choice.finish_reason === 'length') {
    const empty = choice.message.content == null || typeof choice.message.content === 'string' && !choice.message.content.trim();
    if (empty && typeof choice.message.reasoning_content === 'string' && choice.message.reasoning_content.trim()) throw new LocalModelError('reasoning-limit');
    throw new LocalModelError('truncated-output');
  }
  if (choice.finish_reason !== 'stop'
      || choice.message.function_call != null
      || (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0))) throw new LocalModelError('invalid-output');
  if (choice.message.content == null) throw new LocalModelError('empty-output');
  if (typeof choice.message.content !== 'string') throw new LocalModelError('invalid-output');
  const content = choice.message.content.trim();
  if (!content) throw new LocalModelError('empty-output');
  return content;
}
