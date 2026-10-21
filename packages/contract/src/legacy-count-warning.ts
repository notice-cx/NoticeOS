/** The bounded arithmetic messages emitted by the legacy asset count rules.
 * Matching identifies a superseded statistical warning, never arbitrary prose. */
const DAILY = /^last24h\s+([0-9]+)\s+vs\s+avg7d\s+([0-9]+(?:\.[0-9]+)?)\s+\(rule\s+poisson-24h,\s*P<=([0-9.eE+-]+)\)$/i;
const THREE_DAY = /^last72h\s+([0-9]+)\s+vs\s+3d baseline\s+([0-9]+(?:\.[0-9]+)?)\s+\(rule\s+poisson-72h,\s*P<=([0-9.eE+-]+)\)$/i;

export function parseLegacyCountWarning(message: unknown): { observed: number; baseline: number; probability: number; windowHours: 24 | 72 } | null {
  if (typeof message !== 'string' || message.length > 240) return null;
  const daily = message.trim().match(DAILY);
  const match = daily ?? message.trim().match(THREE_DAY);
  if (!match) return null;
  const observed = Number(match[1]);
  const baseline = Number(match[2]);
  const probability = Number(match[3]);
  if (!Number.isSafeInteger(observed) || !Number.isFinite(baseline) || baseline <= observed || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  return { observed, baseline, probability, windowHours: daily ? 24 : 72 };
}

export function isLegacyCountWarning(flag: { kind?: unknown; severity?: unknown; metric?: unknown; msg?: unknown }): boolean {
  return flag.kind === 'anomaly' && flag.severity === 'warn' && typeof flag.metric === 'string' && parseLegacyCountWarning(flag.msg) !== null;
}
import type { PulseEnvelope } from './schema.js';


/** A grammar match alone must not retire an independently authored warning.
 * The warning must also match its owning report's declared counter. */
export function isLegacyEnvelopeCountWarning(flag: { kind?: unknown; severity?: unknown; metric?: unknown; msg?: unknown }, envelope: PulseEnvelope): boolean {
  if (!isLegacyCountWarning(flag) || typeof flag.metric !== 'string') return false;
  const legacy = parseLegacyCountWarning(flag.msg)!;
  const reading = envelope.metrics[flag.metric];
  return !!reading && envelope.capabilities.includes(flag.metric)
    && Math.abs(legacy.baseline - reading.avg7d * (legacy.windowHours / 24)) <= 0.0501 + 0.005 * (legacy.windowHours / 24)
    && (legacy.windowHours !== 24 || legacy.observed === reading.last24h);
}
