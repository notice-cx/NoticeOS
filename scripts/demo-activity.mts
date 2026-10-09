// Dated continuations of a fixed fictional portfolio. These are inputs to the
// ordinary writers, never precomputed alerts, deliveries or business outcomes.
import { createHash } from 'node:crypto';
import { demoActivityPrefix } from './demo-activity-definition.mjs';
import { demoAdPayment, demoAdRevenueMinor, demoRecipeSeasonAngle, demoScenarioHash, demoTrafficShape, demoWeekShape,
  generateDemoScenario, shiftDemoDay, shiftDemoMonth, DEMO_RECIPE_SEASON, type DemoScenario } from './demo-scenario.mjs';

export const DEMO_ACTIVITY_VERSION = 2;
export const DEMO_ACTIVITY_LIMITS = Object.freeze({ daysPerBatch: 7, daysFromAnchor: 36_525 });
const DAY = 86_400_000;
/** Recurring synthetic incidents in a site's tracked action, as [period,
 * first day, length, depth]: the ordinary alert rules find them, and each
 * recovers on its own. Pinwell's matches its seeded story; the young site has
 * none, so no fake low-volume alarm. */
const INCIDENTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  pw: [42, 12, 2, 0.6], lb: [19, 7, 4, 0.55], wp: [13, 2, 4, 0.6],
};
/** Recurring synthetic surges in a site's visits, as [period, first day,
 * length, height]: a recipe shared widely, a brief template linked from a
 * newsletter. Visits and tracked actions rise together and fall back on their
 * own, so Home's brief can say "visitors up" one week and "down" the next
 * without any story being invented for it. The young site has none. */
const BURSTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  wp: [11, 4, 2, 0.5], lb: [23, 15, 1, 0.3], pw: [31, 20, 2, 0.35],
};
/** Every site's search queries, as a synthetic report names them: eight a
 * site, each a fixed share of the site's impressions and a position that
 * drifts week to week. Rankings are scenario choices, never market data. */
const QUERIES: Readonly<Record<string, readonly string[]>> = {
  lb: ['one page brief template', 'weekly brief example', 'how to write a project brief', 'brief export pdf', 'client brief generator', 'project brief checklist', 'creative brief outline', 'brief vs proposal'],
  pw: ['save sources from the web', 'research source manager', 'cite a web page later', 'collect reference links', 'source library app', 'pin research sources', 'organize saved articles', 'web clipper for research'],
  wp: ['weeknight pasta bake', '30 minute chicken dinner', 'sheet pan sausage and peppers', 'easy pantry soup', 'one pot rice and beans', 'quick vegetarian dinner', 'leftover roast chicken recipes', 'freezer friendly meals'],
  fr: ['csv row checker', 'validate csv before import', 'find duplicate rows csv', 'csv empty cells check', 'spreadsheet cleanup tool', 'csv number format errors', 'check csv columns online', 'csv validation rules'],
};
const QUERY_SHARE: readonly number[] = [0.22, 0.17, 0.14, 0.11, 0.1, 0.09, 0.09, 0.08];

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
  source: 'demo-simulator' | 'mediavine';
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
/** A synthetic change recorded when a site's ship task closes, with the
 * 28-day comparison the ordinary watch-window writer registers for it. The
 * release's outcome check reads the comparison later; nothing here claims a
 * result. */
export interface DemoChange {
  asset: string;
  at: string;
  kind: 'deploy';
  ref: string;
  note: string;
  watch: {
    metricIntegration: 'ga4';
    metric: 'sessions';
    baselineStart: string;
    baselineEnd: string;
    checkOffsets: number[];
    thresholds: { ship: { direction: 'up'; min_delta_pct: number }; kill: { direction: 'down'; min_delta_pct: number } };
    note: string;
  };
}
export interface DemoSearchMover {
  query: string;
  currentImpressions: number;
  previousImpressions: number;
  impressionDelta: number;
  impressionDeltaPercent: number;
  currentPosition: number;
  previousPosition: number;
  positionImprovement: number;
}
export interface DemoSearchFinding {
  key: string;
  kind: 'insight' | 'warning';
  title: string;
  summary: string;
  whyItMatters: string;
  primary: { value: string; label: string };
  confidence: 'medium';
  windowStart: string;
  windowEnd: string;
  evidence: { label: string; value: string; detail?: string }[];
  sources: string[];
  caveat: string;
}
/** A site's weekly synthetic search report, in the shape the executive
 * snapshot writer stores and the Overview's Search movers read: this week's
 * queries against last week's, and the one finding the week leads with. */
export interface DemoSearchReport {
  schemaVersion: 1;
  asset: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  sourceArchiveCount: number;
  items: DemoSearchFinding[];
  suppressedItems: never[];
  methodology: string[];
  searchQueries: {
    google: {
      provider: 'google';
      currentStart: string;
      currentEnd: string;
      previousStart: string;
      previousEnd: string;
      daysPerWindow: 7;
      movers: DemoSearchMover[];
      evidence: { label: string; value: string; detail?: string }[];
      source: string;
      caveat: string;
    };
    bing: null;
    dataforseo: null;
  };
}
/** One quarter-hour refresh of today's provisional traffic and search
 * (the `counters` lane's Google step). A missing day stays missing. */
export interface DemoActivityCollection {
  synthetic: true;
  version: 2;
  scenarioHash: string;
  at: string;
  date: string;
  assets: { asset: string; signals: DemoActivitySignal[] }[];
}
export interface DemoActivityDay {
  synthetic: true;
  version: 2;
  scenarioHash: string;
  date: string;
  key: string;
  assets: { asset: string; signals: DemoActivitySignal[]; pulse: DemoActivityPulse | null }[];
  money: DemoActivityMoney[];
  /** Each site's weekly cycle, in site order; a day may hold several. */
  tasks: DemoTaskIntention[];
  changes: DemoChange[];
  reports: DemoSearchReport[];
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
/** Each site's two alternating weekly cycles: a review, then a ship whose
 * close records a change and registers its comparison. */
const WORK: Readonly<Record<string, readonly [review: readonly [string, string], ship: readonly [string, string]]>> = {
  lb: [['Check exported brief headings', 'Compare the synthetic brief preview with its exported headings.'],
    ['Ship the grouped brief library', 'Group the synthetic brief library by project and record the shipped routes.']],
  pw: [['Review saved-source labels', 'Check that saved sources keep their titles and source links.'],
    ['Ship the revised collection labels', 'Apply the synthetic label revision and record the shipped collections.']],
  wp: [['Check printed recipe card margins', 'Print the synthetic recipe cards and check their margins.'],
    ['Ship the seasonal recipe updates', 'Publish the synthetic seasonal recipe updates and record the shipped pages.']],
  fr: [['Verify repeated-row warnings', 'Review the fictional repeated-row examples and their warnings.'],
    ['Ship the CSV input checklist', 'Publish the synthetic CSV input checklist and record the shipped help route.']],
};
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Capture one original scenario. Advancing time never regenerates its seed,
 * asset identities, historical incidents, task history or accounting anchor.
 * Cumulative counters use bounded closed-form sums, not a scan of elapsed days.
 * This factory is pure; deployment separately binds workspace and authority. */
export function createDemoActivity(input: DemoScenario): {
  day(date: string): DemoActivityDay;
  batch(first: string, last: string): DemoActivityDay[];
  collection(at: string): DemoActivityCollection;
  adRevenue(asset: string, date: string): number;
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
    const recipes = asset.prefix === 'wp';
    const growth = asset.prefix === 'fr' ? 0.45 : recipes ? 0.15 : 0.06;
    const phase = draw(seed, `${asset.id}/season`) * 2 * Math.PI;
    const week = demoWeekShape(asset.prefix), weekTotal = week.reduce((a, b) => a + b, 0);
    const weekly = (n: number): number => {
      let sum = Math.floor(n / 7) * weekTotal;
      for (let i = 0; i < n % 7; i++) sum += week[(anchorWeekday + i) % 7]!;
      return sum;
    };
    const [period, first, length, depth] = INCIDENTS[asset.prefix] ?? [1, 0, 0, 0];
    const incidentDays = (n: number): number => Math.floor(n / period) * length + Math.min(length, Math.max(0, n % period - first));
    const [burstPeriod, burstFirst, burstLength, burstHeight] = BURSTS[asset.prefix] ?? [1, 0, 0, 0];
    const burstDays = (n: number): number => Math.floor(n / burstPeriod) * burstLength + Math.min(burstLength, Math.max(0, n % burstPeriod - burstFirst));
    // A recipe site continues the seeded year (`demoRecipeSeasonAngle`), relative
    // to its level at the anchor; the others keep a gentle wave of their own.
    const omega = 2 * Math.PI / 365.25, angle = demoRecipeSeasonAngle(referenceDate);
    const season = (n: number): number => recipes
      ? DEMO_RECIPE_SEASON / (1 + DEMO_RECIPE_SEASON * Math.cos(angle)) * ((Math.sin(angle + n * omega) - Math.sin(angle)) / omega - n * Math.cos(angle))
      : 0.07 / omega * (Math.cos(phase) - Math.cos(phase + n * omega));
    const area = (n: number, metric: 'events' | 'sessions'): number => {
      if (n === 0) return 0;
      const trend = growth * (n <= 365 ? n * n / 730 : n - 182.5);
      const noise = (draw(seed, `${asset.id}/${metric}/${n}`) - draw(seed, `${asset.id}/${metric}/0`)) * 0.08;
      return weekly(n) + trend + season(n) + noise + burstDays(n) * burstHeight - (metric === 'events' ? incidentDays(n) * depth : 0);
    };
    const cumulative = (n: number, metric: 'events' | 'sessions'): number =>
      Math.floor((metric === 'events' ? baseEvents : baseSessions) * area(n, metric));
    const count = (n: number, metric: 'events' | 'sessions'): number =>
      cumulative(n + 1, metric) - cumulative(n, metric);
    const shape = demoTrafficShape(asset.prefix);
    /** One day's search counts: the seeded row before the anchor, the
     * continuation's after it. The daily facts and the weekly report agree. */
    const search = (n: number): { clicks: number; impressions: number; position: number } => {
      if (n < 0) { const row = rows.at(n)!; return { clicks: row.clicks, impressions: row.impressions, position: row.position }; }
      const date = shiftDemoDay(referenceDate, n);
      const clicks = Math.round(count(n, 'sessions') * shape.clicks);
      return { clicks, impressions: clicks * shape.impressionsPerClick + Math.round(draw(seed, `${asset.id}/${date}/search`) * 100),
        position: Math.round((shape.position + draw(seed, `${asset.id}/${date}/position`) * shape.positionSpread) * 100) / 100 };
    };
    return { asset, rows, initialTotal, cumulative, count, search };
  });
  /** One day's synthetic ad estimate: seeded sessions before the anchor, the
   * continuation's after it. */
  const adRevenue = (assetId: string, date: string): number => {
    const input = assetInputs.find(entry => entry.asset.id === assetId && entry.asset.adRpm);
    const ordinal = dateNumber(date) - anchor;
    if (!input || date < input.asset.createdAt.slice(0, 10) || ordinal > DEMO_ACTIVITY_LIMITS.daysFromAnchor) refuse();
    const sessions = ordinal < 0 ? input.rows.find(row => row.date === date)!.sessions : input.count(ordinal, 'sessions');
    return demoAdRevenueMinor(seed, input.asset, date, sessions);
  };
  const monthDates = (month: string): string[] => {
    const days: string[] = [];
    for (let date = `${month}-01`; date.startsWith(month); date = shiftDemoDay(date, 1)) days.push(date);
    return days;
  };
  const firstMonday = anchor + (8 - anchorWeekday) % 7;
  const day = (date: string): DemoActivityDay => {
    const ordinal = dateNumber(date) - anchor;
    if (ordinal < 0 || ordinal > DEMO_ACTIVITY_LIMITS.daysFromAnchor) refuse();
    const key = `${demoActivityPrefix(hash)}${date}`;
    const assets = assetInputs.map(({ asset, rows, initialTotal, cumulative, count, search }) => {
      const sessions = count(ordinal, 'sessions'), events = count(ordinal, 'events'), shape = demoTrafficShape(asset.prefix);
      const pageViews = Math.round(sessions * (shape.pages + draw(seed, `${asset.id}/${date}/pages`) * shape.pagesSpread));
      const activeUsers = Math.round(sessions * shape.activeUsers);
      const { clicks, impressions, position } = search(ordinal);
      const reportMissing = asset.prefix === 'pw' && ordinal % 29 === 10;
      const observations = (values: Record<string, number>) => Object.entries(values).map(([metric, value]) => ({ date, metric, value }));
      const signals: DemoActivitySignal[] = [
        { integration: 'ga4', propertyRef: `demo-${asset.prefix}-ga4`, credentialRef: 'synthetic-demo', timeZone: 'UTC',
          observations: reportMissing ? null : observations({ sessions, active_users: activeUsers, page_views: pageViews, event_count: sessions + pageViews + events }) },
        { integration: 'gsc', propertyRef: `demo-${asset.prefix}-gsc`, credentialRef: 'synthetic-demo', timeZone: 'UTC',
          observations: observations({ clicks, impressions, ctr: impressions === 0 ? 0 : clicks / impressions, position }) },
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
      // An ad network pays each month on the sixth of the second month after
      // it; the seed booked every payment made before the anchor day.
      if (asset.adRpm && date.endsWith('-06')) {
        const month = shiftDemoMonth(date.slice(0, 7), -2);
        const dates = monthDates(month).filter(day => day >= asset.createdAt.slice(0, 10));
        const payment = demoAdPayment(seed, asset, month, dates.map(day => adRevenue(asset.id, day)));
        if (dates.length && payment.paidOn === date) {
          money.push({ asset: asset.id, kind: 'revenue', family: 'ads', period: month, amountMinor: payment.minor,
            currency: 'USD', bookingState: 'reconciled', source: 'mediavine', externalId: `${key}/${asset.prefix}/payment`,
            note: 'Synthetic ad network payment; no real payout.', coverageStart: dates[0]!, coverageEnd: dates.at(-1)!, coverageComplete: true });
        }
      }
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
    // Days since the first Monday after the anchor. Each site runs its own
    // weekly cycle one day after the site before it (filed, started two days
    // later, closed two days after that), reviews and ships alternating, so
    // most days close one task and every other week each site ships.
    const dayIndex = anchor + ordinal - firstMonday;
    const tasks: DemoTaskIntention[] = [];
    const changes: DemoChange[] = [];
    assetInputs.forEach(({ asset }, index) => {
      const since = dayIndex - index;
      if (since < 0) return;
      const cycle = Math.floor(since / 7), phase = since % 7;
      if (phase !== 0 && phase !== 2 && phase !== 4) return;
      const ship = cycle % 2 === 1;
      const copy = WORK[asset.prefix]![ship ? 1 : 0];
      const cycleStart = shiftDemoDay(referenceDate, firstMonday - anchor + cycle * 7 + index);
      const taskKey = `demo-v2-${hash.slice(0, 12)}-${asset.prefix}-${cycleStart}`;
      tasks.push({ asset: asset.id, key: taskKey, phase: phase === 0 ? 'create' : phase === 2 ? 'start' : 'complete',
        title: copy[0], description: `${copy[1]} This is a simulated ${ship ? 'change' : 'review'} of fictional data.`,
        acceptance: ship
          ? 'Record the synthetic change and its registered comparison; do not claim a live deployment or business improvement.'
          : 'Record the synthetic review result; do not claim a live deployment or business improvement.',
        closeReason: ship
          ? 'Synthetic change recorded with a 28-day comparison. No live deployment or measured business improvement.'
          : 'Synthetic review completed. No live deployment or measured business improvement.' });
      if (ship && phase === 4) {
        changes.push({ asset: asset.id, at: `${date}T15:00:00.000Z`, kind: 'deploy', ref: taskKey,
          note: `Synthetic change: ${copy[0].replace(/^Ship /u, '')}. No live deployment.`,
          watch: { metricIntegration: 'ga4', metric: 'sessions', baselineStart: shiftDemoDay(date, -28), baselineEnd: shiftDemoDay(date, -1), checkOffsets: [28],
            thresholds: { ship: { direction: 'up', min_delta_pct: 10 }, kill: { direction: 'down', min_delta_pct: 10 } },
            note: 'Synthetic comparison; no causal revenue claim.' } });
      }
    });
    // Every Monday, each site's search report: this week's queries against
    // last week's, from the same daily impressions the signals carry.
    const reports: DemoSearchReport[] = [];
    if (dayIndex >= 0 && dayIndex % 7 === 0) {
      const week = dayIndex / 7;
      const currentStart = shiftDemoDay(date, -7), currentEnd = shiftDemoDay(date, -1);
      const previousStart = shiftDemoDay(date, -14), previousEnd = shiftDemoDay(date, -8);
      for (const { asset, search } of assetInputs) {
        const weekly = (from: number): number => Array.from({ length: 7 }, (_, i) => search(from + i).impressions).reduce((a, b) => a + b, 0);
        const current = weekly(ordinal - 7), previous = weekly(ordinal - 14);
        const movers = QUERIES[asset.prefix]!.map((query, k): DemoSearchMover => {
          const share = QUERY_SHARE[k]!, base = 2 + k * 1.6;
          const phaseOf = draw(seed, `${asset.id}/query-${k}/phase`) * 2 * Math.PI;
          const position = (w: number): number => Math.max(1, round1(base + 2.5 * Math.sin(phaseOf + (w + k * 0.9) * 1.1)));
          const currentImpressions = Math.round(current * share * (0.85 + draw(seed, `${asset.id}/query-${k}/${currentStart}`) * 0.3));
          const previousImpressions = Math.round(previous * share * (0.85 + draw(seed, `${asset.id}/query-${k}/${previousStart}`) * 0.3));
          const currentPosition = position(week), previousPosition = position(week - 1);
          return { query, currentImpressions, previousImpressions, impressionDelta: currentImpressions - previousImpressions,
            impressionDeltaPercent: previousImpressions === 0 ? 0 : round1((currentImpressions - previousImpressions) / previousImpressions * 100),
            currentPosition, previousPosition, positionImprovement: round1(previousPosition - currentPosition) };
        });
        const ranked = [...movers].sort((a, b) => b.positionImprovement - a.positionImprovement);
        const rising = ranked[0]!.positionImprovement > 0;
        const lead = rising ? ranked[0]! : ranked.at(-1)!;
        const places = Math.abs(lead.positionImprovement).toFixed(1);
        reports.push({ schemaVersion: 1, asset: asset.id, generatedAt: `${date}T05:30:00.000Z`, windowStart: previousStart, windowEnd: currentEnd, sourceArchiveCount: 14,
          items: [{ key: `search-${rising ? 'riser' : 'faller'}-${date}`, kind: rising ? 'insight' : 'warning',
            title: `“${lead.query}” ${rising ? 'climbed' : 'slipped'} ${places} places to #${lead.currentPosition}`,
            summary: `Synthetic search report: “${lead.query}” moved from position ${lead.previousPosition} to ${lead.currentPosition} week over week.`,
            whyItMatters: rising ? 'A query climbing toward the first results brings more visits for the same pages.' : 'A query slipping down the results loses visits the pages used to earn.',
            primary: { value: `#${lead.currentPosition}`, label: 'position this week' }, confidence: 'medium', windowStart: currentStart, windowEnd: currentEnd,
            evidence: [{ label: 'Position last week', value: String(lead.previousPosition) }, { label: 'Impressions this week', value: String(lead.currentImpressions) }],
            sources: ['Synthetic search report'], caveat: 'Synthetic data; no search provider was read.' }],
          suppressedItems: [], methodology: ['Synthetic weekly query report derived from the demo scenario; no provider was called.'],
          searchQueries: { google: { provider: 'google', currentStart, currentEnd, previousStart, previousEnd, daysPerWindow: 7, movers,
            evidence: [{ label: 'Grounding queries excluded', value: '0', detail: 'No quoted-literal queries in this window' }],
            source: 'Synthetic search report', caveat: 'Synthetic query movements; no real search data.' }, bing: null, dataforseo: null } });
      }
    }
    return { synthetic: true, version: DEMO_ACTIVITY_VERSION, scenarioHash: hash, date, key, assets, money, tasks, changes, reports };
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
  return Object.freeze({ day, collection, adRevenue, batch(first: string, last: string): DemoActivityDay[] {
    const days = dateNumber(last) - dateNumber(first) + 1;
    if (days < 1 || days > DEMO_ACTIVITY_LIMITS.daysPerBatch) refuse();
    return Array.from({ length: days }, (_, i) => day(shiftDemoDay(first, i)));
  } });
}
