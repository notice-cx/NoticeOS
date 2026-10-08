// Dated continuations of a fixed fictional portfolio. These are inputs to the
// ordinary writers, never precomputed alerts, deliveries or business outcomes.
import { createHash } from 'node:crypto';
import { demoActivityPrefix } from './demo-activity-definition.mjs';
import { demoScenarioHash, generateDemoScenario, shiftDemoDay, type DemoScenario } from './demo-scenario.mjs';

export const DEMO_ACTIVITY_VERSION = 1;
export const DEMO_ACTIVITY_LIMITS = Object.freeze({ daysPerBatch: 7, daysFromAnchor: 36_525 });
const DAY = 86_400_000;
const weekWeights = [0.82, 1.08, 1.08, 1.08, 1.08, 1.08, 0.82] as const;

export interface DemoActivitySignal {
  integration: 'ga4' | 'gsc';
  propertyRef: string;
  credentialRef: 'synthetic-demo';
  timeZone: 'UTC';
  /** Null is a deliberately missing report, never a reported zero. */
  observations: { date: string; metric: string; value: number }[] | null;
}
export interface DemoActivityPulse {
  asset: string;
  generatedAt: string;
  capabilities: string[];
  metrics: Record<string, { last24h: number; avg7d: number; total: number }>;
}
export interface DemoActivityMoney {
  asset: string;
  kind: 'revenue' | 'cost';
  family: string;
  period: string;
  amountMinor: number;
  currency: 'USD';
  bookingState: 'reconciled';
  source: 'demo-simulator';
  externalId: string;
  note: string;
  coverageStart: string;
  coverageEnd: string;
  coverageComplete: boolean;
}
export interface DemoTaskIntention {
  asset: string;
  key: string;
  phase: 'create' | 'start' | 'complete';
  title: string;
  description: string;
  acceptance: string;
  closeReason: string;
}
/** One quarter-hour refresh of today's provisional traffic and search
 * (the `counters` lane's Google step). A missing day stays missing. */
export interface DemoActivityCollection {
  synthetic: true;
  version: 1;
  scenarioHash: string;
  at: string;
  date: string;
  assets: { asset: string; signals: DemoActivitySignal[] }[];
}
export interface DemoActivityDay {
  synthetic: true;
  version: 1;
  scenarioHash: string;
  date: string;
  key: string;
  assets: { asset: string; signals: DemoActivitySignal[]; pulse: DemoActivityPulse | null }[];
  money: DemoActivityMoney[];
  task: DemoTaskIntention | null;
}
function refuse(): never { throw new Error('Demo activity requires its fixed scenario and a bounded dated interval.'); }
function dateNumber(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) refuse();
  const n = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) refuse();
  return n / DAY;
}
const draw = (seed: string, key: string): number =>
  createHash('sha256').update(`${seed}\0activity-v${DEMO_ACTIVITY_VERSION}\0${key}`).digest().readUInt32BE(0) / 2 ** 32;
const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
/** Share of a day's activity in each UTC hour: quiet overnight, busiest early
 * afternoon, an evening bump. The live minute pulse and the quarter-hour
 * refresh read the same day shape. */
export const DEMO_HOUR_SHARE: readonly number[] = (() => {
  const weights = [1.2, 0.9, 0.7, 0.6, 0.6, 0.8, 1.3, 2.2, 3.4, 4.6, 5.4, 5.8,
    5.9, 6.0, 6.1, 6.0, 5.6, 5.0, 4.4, 4.2, 4.5, 4.2, 3.2, 2.0];
  const total = weights.reduce((a, b) => a + b, 0);
  return Object.freeze(weights.map(weight => weight / total));
})();
/** The share of a UTC day's activity counted by the end of `minuteOfDay`. */
export function demoDayShare(minuteOfDay: number): number {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 1440) refuse();
  const hour = Math.floor(minuteOfDay / 60);
  return DEMO_HOUR_SHARE.slice(0, hour).reduce((a, b) => a + b, 0)
    + DEMO_HOUR_SHARE[hour]! * ((minuteOfDay % 60) + 1) / 60;
}
const tasks = [
  ['Check exported brief headings', 'Compare the synthetic brief preview with its exported headings.'],
  ['Review saved-source labels', 'Check that saved sources keep their titles and source links.'],
  ['Verify repeated-row warnings', 'Review the fictional repeated-row examples and their warnings.'],
] as const;

/** Capture one original scenario. Advancing time never regenerates its seed,
 * asset identities, historical incidents, task history or accounting anchor.
 * Cumulative counters use bounded closed-form sums, not a scan of elapsed days.
 * This factory is pure; deployment separately binds workspace and authority. */
export function createDemoActivity(input: DemoScenario): {
  day(date: string): DemoActivityDay;
  batch(first: string, last: string): DemoActivityDay[];
  collection(at: string): DemoActivityCollection;
} {
  const scenario = generateDemoScenario(input.manifest);
  const hash = demoScenarioHash(scenario);
  if (hash !== demoScenarioHash(input)) refuse();
  const { seed, referenceDate } = scenario.manifest;
  const anchor = dateNumber(referenceDate);
  const anchorWeekday = new Date(anchor * DAY).getUTCDay();
  const assetInputs = scenario.assets.filter(asset => !asset.isOs).map(asset => {
    const rows = scenario.daily.filter(row => row.asset === asset.id);
    // The original Pinwell story ends during a conversion incident. Its
    // ordinary demand baseline precedes that incident; new observations show
    // recovery without manufacturing a measured causal explanation.
    const stable = rows.filter(row => row.age < -2).slice(-28);
    const last = scenario.pulses.filter(row => row.asset === asset.id).at(-1)!;
    const initialTotal = last.metrics[asset.event!]!.total;
    const baseEvents = mean(stable.map(row => row.events));
    const baseSessions = mean(stable.map(row => row.sessions));
    const growth = asset.prefix === 'fr' ? 0.45 : 0.06;
    const phase = draw(seed, `${asset.id}/season`) * 2 * Math.PI;
    const weekly = (n: number): number => {
      let sum = Math.floor(n / 7) * 7.04;
      for (let i = 0; i < n % 7; i++) sum += weekWeights[(anchorWeekday + i) % 7]!;
      return sum;
    };
    const incidentDays = (n: number): number => asset.prefix === 'pw'
      ? Math.floor(n / 42) * 2 + Math.min(2, Math.max(0, n % 42 - 12)) : 0;
    const area = (n: number, metric: 'events' | 'sessions'): number => {
      if (n === 0) return 0;
      const trend = growth * (n <= 365 ? n * n / 730 : n - 182.5);
      const season = 0.07 * 365.25 / (2 * Math.PI) * (Math.cos(phase) - Math.cos(phase + n * 2 * Math.PI / 365.25));
      const noise = (draw(seed, `${asset.id}/${metric}/${n}`) - draw(seed, `${asset.id}/${metric}/0`)) * 0.08;
      return weekly(n) + trend + season + noise - (metric === 'events' ? incidentDays(n) * 0.6 : 0);
    };
    const cumulative = (n: number, metric: 'events' | 'sessions'): number =>
      Math.floor((metric === 'events' ? baseEvents : baseSessions) * area(n, metric));
    const count = (n: number, metric: 'events' | 'sessions'): number =>
      cumulative(n + 1, metric) - cumulative(n, metric);
    return { asset, rows, initialTotal, cumulative, count };
  });
  const firstMonday = anchor + (8 - anchorWeekday) % 7;
  const day = (date: string): DemoActivityDay => {
    const ordinal = dateNumber(date) - anchor;
    if (ordinal < 0 || ordinal > DEMO_ACTIVITY_LIMITS.daysFromAnchor) refuse();
    const key = `${demoActivityPrefix(hash)}${date}`;
    const assets = assetInputs.map(({ asset, rows, initialTotal, cumulative, count }) => {
      const sessions = count(ordinal, 'sessions'), events = count(ordinal, 'events');
      const pageViews = Math.round(sessions * (1.6 + draw(seed, `${asset.id}/${date}/pages`) * 0.25));
      const activeUsers = Math.round(sessions * 0.79);
      const clicks = Math.round(sessions * 0.57), impressions = clicks * 18 + Math.round(draw(seed, `${asset.id}/${date}/search`) * 100);
      const reportMissing = asset.prefix === 'pw' && ordinal % 29 === 10;
      const observations = (values: Record<string, number>) => Object.entries(values).map(([metric, value]) => ({ date, metric, value }));
      const signals: DemoActivitySignal[] = [
        { integration: 'ga4', propertyRef: `demo-${asset.prefix}-ga4`, credentialRef: 'synthetic-demo', timeZone: 'UTC',
          observations: reportMissing ? null : observations({ sessions, active_users: activeUsers, page_views: pageViews, event_count: sessions + pageViews + events }) },
        { integration: 'gsc', propertyRef: `demo-${asset.prefix}-gsc`, credentialRef: 'synthetic-demo', timeZone: 'UTC',
          observations: observations({ clicks, impressions, ctr: impressions === 0 ? 0 : clicks / impressions,
            position: Math.round((6 + draw(seed, `${asset.id}/${date}/position`) * 2) * 100) / 100 }) },
      ];
      const recent = Array.from({ length: 7 }, (_, i) => ordinal - 6 + i).map(n =>
        n < 0 ? rows.at(n)!.events : count(n, 'events'));
      const pulse: DemoActivityPulse | null = reportMissing ? null : {
        asset: asset.id, generatedAt: `${date}T23:30:00.000Z`, capabilities: [asset.event!],
        metrics: { [asset.event!]: { last24h: events, avg7d: mean(recent), total: initialTotal + cumulative(ordinal + 1, 'events') } },
      };
      return { asset: asset.id, signals, pulse };
    });
    const month = date.slice(0, 7);
    const nextMonth = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 1));
    const monthDays = Number(new Date(nextMonth.getTime() - DAY).toISOString().slice(8, 10));
    const money: DemoActivityMoney[] = [];
    // The seed already includes the cutoff day's partial receipts and prepaid
    // monthly costs. Continue receipts on the NEXT day; never book them twice.
    for (const asset of scenario.assets) {
      if (ordinal > 0 && asset.revenue !== null && asset.revenueFamily !== null) {
        money.push({ asset: asset.id, kind: 'revenue', family: asset.revenueFamily, period: month,
          amountMinor: Math.round(asset.revenue / monthDays * (0.9 + draw(seed, `${asset.id}/${date}/income`) * 0.2)),
          currency: 'USD', bookingState: 'reconciled', source: 'demo-simulator', externalId: `${key}/${asset.prefix}/income`,
          note: 'Synthetic daily receipts; no real payment or causal lift.', coverageStart: date, coverageEnd: date, coverageComplete: false });
      }
      if (ordinal > 0 && date.endsWith('-01')) {
        money.push({ asset: asset.id, kind: 'cost', family: asset.isOs ? 'os-overhead' : 'infra', period: month,
          amountMinor: Math.round(asset.cost * (0.94 + draw(seed, `${asset.id}/${month}/cost`) * 0.12)),
          currency: 'USD', bookingState: 'reconciled', source: 'demo-simulator', externalId: `${key}/${asset.prefix}/cost`,
          note: 'Synthetic prepaid operating bill; no real charge.', coverageStart: date,
          coverageEnd: shiftDemoDay(nextMonth.toISOString().slice(0, 10), -1), coverageComplete: true });
      }
    }
    const week = Math.floor((anchor + ordinal - firstMonday) / 7);
    const weekday = (anchor + ordinal - firstMonday) % 7;
    let task: DemoTaskIntention | null = null;
    if (week >= 0 && [0, 2, 4].includes(weekday)) {
      const entry = assetInputs[week % assetInputs.length]!, copy = tasks[week % tasks.length]!;
      const weekStart = shiftDemoDay(referenceDate, firstMonday - anchor + week * 7);
      task = { asset: entry.asset.id, key: `demo-v1-${hash.slice(0, 12)}-${weekStart}`, phase: weekday === 0 ? 'create' : weekday === 2 ? 'start' : 'complete',
        title: copy[0], description: `${copy[1]} This is a simulated review of fictional data.`,
        acceptance: 'Record the synthetic review result; do not claim a live deployment or business improvement.',
        closeReason: 'Synthetic review completed. No live deployment or measured business improvement.' };
    }
    return { synthetic: true, version: DEMO_ACTIVITY_VERSION, scenarioHash: hash, date, key, assets, money, task };
  };
  /** Today so far: each provisional count is the finished day's count scaled
   * by the share of the day already counted, so the quarter-hour refreshes
   * rise toward the value the next day's report finalises. Rates and averages
   * (CTR, position) are the day's own. */
  const collection = (at: string): DemoActivityCollection => {
    const instant = typeof at === 'string' ? Date.parse(at) : NaN;
    if (!Number.isFinite(instant) || new Date(instant).toISOString() !== at) refuse();
    const date = at.slice(0, 10), facts = day(date);
    const minute = new Date(instant).getUTCHours() * 60 + new Date(instant).getUTCMinutes();
    const share = demoDayShare(minute);
    const partial = (value: number) => Math.round(value * share);
    const assets = facts.assets.map(({ asset, signals }) => ({ asset, signals: signals.map((signal): DemoActivitySignal => {
      if (signal.observations === null) return signal;
      const final = Object.fromEntries(signal.observations.map(row => [row.metric, row.value]));
      const values: Record<string, number> = signal.integration === 'ga4'
        ? { sessions: partial(final.sessions!), active_users: partial(final.active_users!), page_views: partial(final.page_views!), event_count: partial(final.event_count!) }
        : (() => {
          const clicks = partial(final.clicks!), impressions = partial(final.impressions!);
          return { clicks, impressions, ctr: impressions === 0 ? 0 : clicks / impressions, position: final.position! };
        })();
      return { ...signal, observations: Object.entries(values).map(([metric, value]) => ({ date, metric, value })) };
    }) }));
    return { synthetic: true, version: DEMO_ACTIVITY_VERSION, scenarioHash: hash, at, date, assets };
  };
  return Object.freeze({ day, collection, batch(first: string, last: string): DemoActivityDay[] {
    const days = dateNumber(last) - dateNumber(first) + 1;
    if (days < 1 || days > DEMO_ACTIVITY_LIMITS.daysPerBatch) refuse();
    return Array.from({ length: days }, (_, i) => day(shiftDemoDay(first, i)));
  } });
}
