/** Daily ordered step counts an asset reports for its own funnels; no visitor, session or payment identifiers. */
import { journeyDefinitionId, type JourneyDefinition, type JourneyFunnelResult, type JourneyPeriod } from './journeys.mjs';

export interface FirstPartyFunnelStepCount { id: string; count: number }
/** Each entity counts on the date it entered the first step, so days add up and later steps never exceed earlier ones. */
export interface FirstPartyFunnelReport {
  schemaVersion: 1; source: 'first-party'; journeyId: string; journeyVersion: number; definitionId: string;
  date: string; timeZone: string; unit: string; steps: FirstPartyFunnelStepCount[];
}
export interface FirstPartyFunnelReceipt { generatedAt: string; receivedAt: string; reports: FirstPartyFunnelReport[] }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const journeyId = (v: unknown): v is string => typeof v === 'string' && v.length <= 60 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v);
const publisherId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const unit = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);

function dayAt(at: number, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  return `${p.find(p => p.type === 'year')!.value}-${p.find(p => p.type === 'month')!.value}-${p.find(p => p.type === 'day')!.value}`;
}
const offset = (day: string, days: number) => new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);

export function readFirstPartyFunnelReport(v: unknown): FirstPartyFunnelReport | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'source', 'journeyId', 'journeyVersion', 'definitionId', 'date', 'timeZone', 'unit', 'steps']) ||
    v.schemaVersion !== 1 || v.source !== 'first-party' || !journeyId(v.journeyId) ||
    !Number.isSafeInteger(v.journeyVersion) || Number(v.journeyVersion) < 1 || Number(v.journeyVersion) > 1_000_000 ||
    !publisherId(v.definitionId) || !date(v.date) || typeof v.timeZone !== 'string' || v.timeZone.length > 64 || !unit(v.unit) ||
    !Array.isArray(v.steps) || v.steps.length < 2 || v.steps.length > 10) return null;
  try { dayAt(0, v.timeZone); } catch { return null; }
  const steps: FirstPartyFunnelStepCount[] = [], ids = new Set<string>();
  for (const step of v.steps) {
    if (!record(step) || !keys(step, ['id', 'count']) || !journeyId(step.id) || ids.has(step.id) || !count(step.count) ||
      (steps.length > 0 && step.count > steps.at(-1)!.count)) return null;
    ids.add(step.id); steps.push({ id: step.id, count: step.count });
  }
  return { schemaVersion: 1, source: 'first-party', journeyId: v.journeyId, journeyVersion: Number(v.journeyVersion), definitionId: v.definitionId,
    date: v.date, timeZone: v.timeZone, unit: v.unit, steps };
}

/** A report covers a day that has ended in its own time zone; resending a day replaces it. */
export function readFirstPartyFunnelReports(v: unknown, generatedAt?: string): FirstPartyFunnelReport[] | null {
  if (!Array.isArray(v) || v.length > 64) return null;
  const reports: FirstPartyFunnelReport[] = [], seen = new Set<string>();
  for (const raw of v) {
    const r = readFirstPartyFunnelReport(raw);
    if (!r || (generatedAt !== undefined && (!Number.isFinite(Date.parse(generatedAt)) || r.date >= dayAt(Date.parse(generatedAt), r.timeZone)))) return null;
    const key = `${r.journeyId}:${r.date}`;
    if (seen.has(key)) return null;
    seen.add(key); reports.push(r);
  }
  return reports;
}

const VISITORS = { users: null, quality: 'unavailable' as const, reason: 'The asset reports this journey from its first step.' };

function period(definition: JourneyDefinition, reports: readonly FirstPartyFunnelReport[], kind: JourneyPeriod['kind'], startDate: string, days: number): JourneyPeriod {
  const endDate = offset(startDate, days - 1);
  const rows = reports.filter(r => r.date >= startDate && r.date <= endDate);
  const unavailable = (reason: string): JourneyPeriod => ({ kind, startDate, endDate, complete: true, quality: 'unavailable', reason,
    steps: definition.steps.map(step => ({ id: step.id, users: null })), visitors: VISITORS });
  if (rows.length < days) return unavailable(`The asset reported ${rows.length} of ${days} days.`);
  const first = rows[0]!;
  if (rows.some(r => r.definitionId !== first.definitionId || r.unit !== first.unit || r.timeZone !== first.timeZone)) {
    return unavailable('The asset changed how it counts this journey within these dates.');
  }
  return { kind, startDate, endDate, complete: true, quality: 'complete', visitors: VISITORS,
    steps: definition.steps.map((step, index) => ({ id: step.id, users: rows.reduce((sum, r) => sum + r.steps[index]!.count, 0) })) };
}

/** Builds the same periods a GA4 funnel shows from the newest stored report for each closed day. */
export function buildFirstPartyFunnelResult(definition: JourneyDefinition, receipts: readonly FirstPartyFunnelReceipt[], now: Date): JourneyFunnelResult | null {
  if (definition.source !== 'first-party' || definition.kind !== 'funnel') return null;
  const days = new Map<string, { report: FirstPartyFunnelReport; receivedAt: string }>();
  for (const receipt of [...receipts].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.generatedAt.localeCompare(a.generatedAt))) {
    for (const r of receipt.reports) {
      if (r.journeyId !== definition.id || days.has(r.date) || r.date >= dayAt(now.getTime(), r.timeZone)) continue;
      days.set(r.date, { report: r, receivedAt: receipt.receivedAt });
    }
  }
  // A newer report of an earlier version still claims its day, which stays unavailable instead of showing older counts.
  const used = [...days.values()].filter(({ report: r }) => r.journeyVersion === definition.version && r.steps.length === definition.steps.length &&
    r.steps.every((step, index) => step.id === definition.steps[index]!.id));
  const reports = used.map(({ report }) => report).sort((a, b) => b.date.localeCompare(a.date));
  const latest = reports[0];
  if (!latest) return null;
  const collectedAt = used.map(({ receivedAt }) => receivedAt).sort().at(-1)!;
  const lag = definition.reportingLagDays ?? 1;
  const today = offset(dayAt(now.getTime(), latest.timeZone), 1 - lag);
  const weekday = new Date(today).getUTCDay();
  const monday = offset(today, -((weekday + 6) % 7));
  const earliest = reports.at(-1)!.date;
  const weekly = Array.from({ length: 12 }, (_, i) => offset(monday, (i - 12) * 7))
    .filter(start => offset(start, 6) >= earliest)
    .map(start => period(definition, reports, 'week', start, 7));
  return { journeyId: definition.id, definitionId: journeyDefinitionId(definition), propertyId: null, timeZone: latest.timeZone,
    identity: 'first-party', unit: latest.unit, collectedAt,
    current7: period(definition, reports, 'current7', offset(today, -7), 7), prior7: period(definition, reports, 'prior7', offset(today, -14), 7),
    current28: period(definition, reports, 'current28', offset(today, -28), 28), prior28: period(definition, reports, 'prior28', offset(today, -56), 28),
    weekly };
}
