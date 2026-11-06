import type { WorkflowDiagnostic, WorkflowStepDiagnostics } from '../packages/contract/src/workflows.js';
import { redactLogText } from './os-log.mjs';

const MAX_BYTES = 65_536;
const encoder = new TextEncoder();
const secretKey = (key: string) => /(?:secret|token|password|passwd|authorization|cookie|credential|privatekey|apikey|connectionstring)/i.test(key.replace(/[^a-z0-9]/gi, ''))
  || /^(?:env|bindings?|store)$/i.test(key);
const byteLength = (value: string) => encoder.encode(value).byteLength;
function prefix(value: string, maxBytes: number): string {
  let result = '', size = 0;
  for (const character of value) { const bytes = byteLength(character); if (size + bytes > maxBytes) break; result += character; size += bytes; }
  return result;
}
function redactText(value: string): string {
  return redactLogText(value).replace(/-----BEGIN [^-\r\n]+-----[\s\S]*$/gu, '[REDACTED PRIVATE MATERIAL]');
}
function clippedText(value: string, maxBytes: number): string {
  let result = prefix(value, maxBytes);
  for (const marker of ['[REDACTED]', '[REDACTED PRIVATE MATERIAL]']) {
    for (let count = 1; count < marker.length; count++) if (result.endsWith(marker.slice(0, count))) {
      result = result.slice(0, -count); break;
    }
  }
  // A cut credential assignment must not become an unstable partial redaction.
  for (let count = 0; count < 16 && redactText(result) !== result; count++) {
    const boundary = Math.max(...[' ', '\n', '\t', '?', '&', ',', '{', ';'].map(character => result.lastIndexOf(character)));
    result = boundary >= 0 ? result.slice(0, boundary) : '';
  }
  return redactText(result) === result ? result : '';
}

function tailMatch(text: string, pattern: string, fallback: readonly number[]): number {
  let matched = 0;
  for (let index = 0; index < text.length; index++) {
    while (matched > 0 && (matched === pattern.length || pattern[matched] !== text[index])) matched = fallback[matched - 1]!;
    if (pattern[matched] === text[index]) matched++;
  }
  return matched === pattern.length ? fallback[matched - 1]! : matched;
}
function prefixFallback(pattern: string): number[] {
  const result = new Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index++) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = result[matched - 1]!;
    if (pattern[index] === pattern[matched]) matched++;
    result[index] = matched;
  }
  return result;
}

/** Structured arguments only: callers never pass an environment or credential bundle. */
export function captureWorkflowDiagnostic(value: unknown, { secrets = [], maxBytes = 16_384, inputTruncated = false }: {
  secrets?: readonly string[]; maxBytes?: number; inputTruncated?: boolean;
} = {}): WorkflowDiagnostic {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new RangeError('Invalid workflow diagnostic limit.');
  let redacted = false, truncated = inputTruncated, visited = 0;
  const ancestors = new Set<object>();
  const secretVariants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    let encoded = secret;
    for (let depth = 0; depth <= 6; depth++) {
      secretVariants.add(encoded);
      const next = JSON.stringify(encoded).slice(1, -1);
      if (next === encoded || byteLength(next) > MAX_BYTES) break;
      encoded = next;
    }
  }
  // Raw response bodies and retained error envelopes can contain several JSON string layers.
  const replacements = [...secretVariants].sort((a, b) => b.length - a.length);
  const tailMatchers = inputTruncated ? replacements.map(pattern => ({ pattern, fallback: prefixFallback(pattern) })) : [];
  const scrub = (value: string, clipped = false): string => {
    let text = value;
    for (const secret of replacements) text = text.split(secret).join('[REDACTED]');
    if (clipped) {
      let matched = 0;
      for (const { pattern, fallback } of tailMatchers) matched = Math.max(matched, tailMatch(text, pattern, fallback));
      if (matched > 0) text = `${text.slice(0, -matched)}[REDACTED]`;
    }
    text = redactText(text);
    if (text !== value) redacted = true;
    return text;
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (++visited > 1000 || depth > 6) { truncated = true; return '[Details omitted]'; }
    if (typeof value === 'string') {
      const text = scrub(value, inputTruncated);
      if (byteLength(text) > MAX_BYTES) { truncated = true; return clippedText(text, MAX_BYTES); }
      return text;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'function') return '[Function]';
    if (typeof value !== 'object') return String(value);
    if (ancestors.has(value)) { truncated = true; return '[Circular reference]'; }
    ancestors.add(value);
    try {
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date';
      if (typeof Headers !== 'undefined' && value instanceof Headers) return walk(Object.fromEntries(value.entries()), depth + 1);
      if (Array.isArray(value)) {
        if (value.length > 100) truncated = true;
        return Array.from({ length: Math.min(value.length, 100) }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor) return null;
          if ('value' in descriptor) return walk(descriptor.value, depth + 1);
          truncated = true; return '[Accessor omitted]';
        });
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (value instanceof Error) {
        descriptors.name ??= { value: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'name')?.value ?? 'Error' };
        descriptors.message ??= { value: '' };
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = Object.keys(descriptors);
      if (keys.length > 100) truncated = true;
      for (const key of keys.slice(0, 100)) {
        const descriptor = descriptors[key]!;
        if (secretKey(key)) { result[scrub(key)] = '[REDACTED]'; redacted = true; }
        else if ('value' in descriptor) result[scrub(key)] = walk(descriptor.value, depth + 1);
        else { result[scrub(key)] = '[Accessor omitted]'; truncated = true; }
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  let safe: unknown;
  try { safe = walk(value, 0); } catch { safe = '[Value unavailable]'; truncated = true; }
  let text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2);
  text = scrub(text);
  if (byteLength(text) > maxBytes) { text = clippedText(text, maxBytes); truncated = true; }
  return { text, truncated, redacted };
}

export function isWorkflowStepDiagnostics(value: unknown): value is WorkflowStepDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 3 && entries.every(([key, item]: [string, unknown]) => {
    if (!['input', 'output', 'error'].includes(key) || !item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return Object.keys(row).sort().join(',') === 'redacted,text,truncated' && typeof row.text === 'string'
      && typeof row.truncated === 'boolean' && typeof row.redacted === 'boolean' && byteLength(row.text) <= MAX_BYTES
      && captureWorkflowDiagnostic(row.text, { maxBytes: MAX_BYTES }).text === row.text;
  });
}


export const WORKFLOW_RUN_DIAGNOSTIC_BYTES = 131_072;
/** Cap aggregate serialized diagnostic JSON, rebalancing large inputs so new errors receive space. */
export function boundWorkflowRunDiagnostics(steps: readonly { diagnostics?: WorkflowStepDiagnostics }[], maxBytes = WORKFLOW_RUN_DIAGNOSTIC_BYTES): void {
  const fields: { owner: WorkflowStepDiagnostics; key: keyof WorkflowStepDiagnostics; value: WorkflowDiagnostic; size: number }[] = [];
  const cost = (key: string, value: WorkflowDiagnostic) => byteLength(JSON.stringify({ [key]: value }));
  for (const step of steps) if (step.diagnostics) for (const key of ['input', 'output', 'error'] as const) {
    const value = step.diagnostics[key]; if (value) fields.push({ owner: step.diagnostics, key, value, size: cost(key, value) });
  }
  if (fields.reduce((sum, field) => sum + field.size, 0) <= maxBytes) return;
  let remaining = maxBytes;
  const pending = [...fields].sort((a, b) => a.size - b.size);
  for (let index = 0; index < pending.length; index++) {
    const field = pending[index]!;
    const share = Math.floor(remaining / (pending.length - index));
    const overhead = cost(field.key, { text: '', truncated: true, redacted: field.value.redacted });
    if (share < overhead) { delete field.owner[field.key]; continue; }
    let limit = Math.min(byteLength(field.value.text), MAX_BYTES);
    let safe = { ...field.value };
    while (cost(field.key, safe) > share) {
      const content = Math.max(1, cost(field.key, safe) - overhead);
      limit = Math.max(0, Math.min(limit - 1, Math.floor(limit * (share - overhead) / content) - 1));
      const clipped = limit ? captureWorkflowDiagnostic(field.value.text, { maxBytes: limit }) : { text: '', truncated: true, redacted: false };
      safe = { ...clipped, truncated: true, redacted: clipped.redacted || field.value.redacted };
    }
    field.owner[field.key] = safe;
    remaining -= cost(field.key, safe);
  }
}
