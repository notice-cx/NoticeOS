// Synthetic facts for the ordinary NoticeOS store (ro-ujb9.256.2).
// Scenario choices, not estimates of real businesses; see the dated brief.
import { createHash } from 'node:crypto';
import { generateDemoTaskFacts } from './demo-task-facts.mjs';

export const SCENARIO_VERSION = 3;
const DAY_MS = 86_400_000;
export interface DemoAsset { id: string; name: string; prefix: string; days: number; sessions: number | null; revenue: number | null; revenueFamily: 'subs' | 'licensing' | null; cost: number; event: string | null; isOs?: boolean; }
export interface DemoSite extends DemoAsset { createdAt: string; domain: string | null; status: string; }
export interface DemoDay { asset: string; date: string; sessions: number; age: number; pageViews: number; activeUsers: number; events: number; eventCount: number; clicks: number; impressions: number; ctr: number; position: number; reportMissing: boolean; provisional: boolean; }
export interface DemoLedger { key: string; currency: string; note: string; asset: string; period: string; kind: 'revenue' | 'cost'; family: string; minor: number; state: 'estimated' | 'reconciled'; source: string; recordedAt: string; coverageStart?: string; coverageEnd?: string; coverageComplete?: boolean; supersedes?: string; }
export interface DemoPulse { asset: string; date: string; generatedAt: string; capabilities: string[]; metrics: Record<string, { last24h: number; avg7d: number; total: number }>; }
export interface DemoInput { seed: string; cutoff: string; release: string; timeZone?: string; }

export const DEMO_ASSETS: readonly DemoAsset[] = Object.freeze([
  { id: 'lightbrief.example', name: 'Light Brief', prefix: 'lb', days: 400, sessions: 66000, revenue: 180000, revenueFamily: 'subs', cost: 26000, event: 'brief_exports' },
  { id: 'pinwell.example', name: 'Pinwell', prefix: 'pw', days: 400, sessions: 28000, revenue: 52000, revenueFamily: 'licensing', cost: 13000, event: 'source_saves' },
  { id: 'freshrows.example', name: 'Fresh Rows', prefix: 'fr', days: 24, sessions: null, revenue: null, revenueFamily: null, cost: 6000, event: 'completed_checks' },
  { id: 'noticeos', name: 'NoticeOS', prefix: 'no', days: 400, sessions: null, revenue: null, revenueFamily: null, cost: 21000, event: null, isOs: true },
]);

export function shiftDemoDay(day: string, offset: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

function monthOffset(period: string, offset: number) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 7);
}

function clockDay(cutoff: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(cutoff));
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Independent keyed draws: adding a metric cannot move another series. */
function draw(seed: string, key: string) {
  return createHash('sha256').update(`${seed}\0${key}`).digest().readUInt32BE(0) / 2 ** 32;
}

/** Largest remainders allocate an integer total without losing a cent/count. */
function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map(weight => weight * total / sum);
  const result = exact.map(Math.floor);
  const order = exact.map((value, i) => ({ i, remainder: value - result[i]! })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let n = total - result.reduce((a, b) => a + b, 0), i = 0; i < n; i++) result[order[i]!.i] = result[order[i]!.i]! + 1;
  return result;
}

/** All identities, times, traffic and money originate in this manifest. */
export function generateDemoScenario({ seed, cutoff, release, timeZone = 'UTC' }: DemoInput) {
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 128) throw new Error('Name an explicit demo seed.');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(cutoff) || !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff) throw new Error('Name an exact UTC cutoff.');
  if (!/^[a-f0-9]{40}$/u.test(release)) throw new Error('Name the exact public release commit.');
  if (timeZone !== 'UTC') throw new Error('The scenario uses explicit UTC reporting zones.');
  const referenceDate = clockDay(cutoff, timeZone);
  const period = referenceDate.slice(0, 7);
  // The readable accounting anchor predates the repair baseline and launch. Its
  // genuine costs remain in every month in which it actually existed.
  const referencePeriod = monthOffset(shiftDemoDay(referenceDate, -70).slice(0, 7), -1);
  const identity = createHash('sha256').update(JSON.stringify({ seed, cutoff, release, timeZone, version: SCENARIO_VERSION })).digest('hex');
  const workspaceId: `${string}-${string}-${string}-${string}-${string}` = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  const assets = DEMO_ASSETS.map(a => ({ ...a, id: a.isOs ? `os-${identity.slice(32, 48)}` : a.id, createdAt: `${shiftDemoDay(referenceDate, -a.days)}T00:00:00.000Z`, domain: a.isOs ? null : a.id, status: a.days === 24 ? 'baselining' : 'live' }));
  const daily: DemoDay[] = [];
  for (const asset of assets.filter(a => !a.isOs)) {
    const rows: DemoDay[] = [];
    for (let age = -asset.days; age < 0; age++) {
      const date = shiftDemoDay(referenceDate, age);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const annual = Math.sin(2 * Math.PI * (Date.parse(`${date}T00:00:00Z`) / DAY_MS % 365.25) / 365.25);
      const weekend = weekday === 0 || weekday === 6;
      const ownWeek = weekend ? 0.82 : 1.08;
      const noise = 0.92 + draw(seed, `${asset.id}/${date}/demand`) * 0.16;
      const shared = 0.96 + draw(seed, `${date}/shared-demand`) * 0.08;
      const trend = asset.days === 24 ? (1 + (24 + age) * 0.027) : (1 + (400 + age) * 0.00015);
      const referralSpike = age >= -95 && age <= -93;
      const repair = asset.prefix === 'lb' && age >= -60 && age <= -43;
      const traffic = Math.max(1, Math.round((asset.days === 24 ? 18 : asset.prefix === 'lb' ? 2000 : 820) * ownWeek * (1 + annual * (asset.prefix === 'pw' ? 0.2 : 0.09)) * noise * shared * trend * (referralSpike ? 1.7 : 1) * (repair ? 0.68 : 1)));
      rows.push({ pageViews: 0, activeUsers: 0, events: 0, eventCount: 0, clicks: 0, impressions: 0, ctr: 0, position: 0, reportMissing: false, provisional: false, asset: asset.id, date, sessions: traffic, age });
    }
    // This completed month is the brief's exact readable accounting anchor.
    const anchor = rows.filter(r => r.date.startsWith(referencePeriod));
    if (asset.sessions !== null) {
      const counts = allocate(asset.sessions, anchor.map(r => r.sessions));
      anchor.forEach((r, i) => { r.sessions = counts[i]!; });
    }
    for (const row of rows) {
      row.pageViews = Math.round(row.sessions * (1.55 + draw(seed, `${asset.id}/${row.date}/pages`) * 0.3));
      row.activeUsers = Math.max(1, Math.round(row.sessions * 0.79));
      row.events = Math.round(row.sessions * (asset.prefix === 'pw' && row.age >= -2 ? 0.001 : 0.065));
      row.eventCount = row.pageViews + row.sessions + row.events;
      row.clicks = Math.round(row.sessions * 0.57);
      row.impressions = row.clicks * 18 + Math.round(draw(seed, `${asset.id}/${row.date}/search`) * 100);
      row.ctr = row.clicks / row.impressions;
      row.position = Math.round((6 + draw(seed, `${asset.id}/${row.date}/position`) * 2) * 100) / 100;
      row.reportMissing = asset.prefix === 'pw' && row.age === -5;
      row.provisional = row.age >= -3;
      daily.push(row);
    }
  }
  const ledger: DemoLedger[] = [];
  const add = (row: Omit<DemoLedger, 'key' | 'currency' | 'note'>, note = 'Synthetic demo accounting.') => { const value = { key: `ledger-${ledger.length + 1}`, currency: 'USD', note, ...row }; ledger.push(value); return value.key; };
  for (let offset = -12; offset <= 0; offset++) {
    const month = monthOffset(period, offset);
    const anchorMonth = month === referencePeriod;
    const monthEnd = shiftDemoDay(`${monthOffset(month, 1)}-01`, -1);
    const recordedAt = offset === 0 ? cutoff : `${monthEnd}T23:00:00.000Z`;
    for (const asset of assets) {
      if (asset.createdAt.slice(0, 10) > monthEnd) continue;
      const cost = asset.prefix === 'fr' ? asset.cost : Math.round(asset.cost * (anchorMonth ? 1 : 0.94 + draw(seed, `${asset.id}/${month}/cost`) * 0.12));
      add({ asset: asset.id, period: month, kind: 'cost', family: asset.isOs ? 'os-overhead' : 'infra', minor: cost, state: 'reconciled', source: 'demo', recordedAt }, offset === 0 ? 'Synthetic prepaid operating bill recorded this month.' : 'Synthetic demo accounting.');
      if (asset.revenue === null || asset.revenueFamily === null) continue;
      const coverageStart = `${month}-01`;
      if (offset === 0) {
        // A fictional first posting precedes any current-period receipt. No
        // scheduled or future sale is booked; coverage ends at this cutoff.
        const firstPosting = `${month}-01T01:00:00.000Z`;
        if (cutoff < firstPosting) continue;
        const elapsedDays = (Date.parse(cutoff) - Date.parse(firstPosting)) / DAY_MS;
        const collected = Math.round(asset.revenue * Math.min(0.95, 0.125 + elapsedDays * 0.025));
        add({ asset: asset.id, period: month, kind: 'revenue', family: asset.revenueFamily, minor: collected, state: 'reconciled', source: 'demo-recorded-income', recordedAt: cutoff, coverageStart, coverageEnd: referenceDate, coverageComplete: false }, 'Synthetic partial-month income; later receipts are not yet recorded.');
        continue;
      }
      // Recorded income is independent of traffic. These monthly entries do
      // not describe recurring contracts, payment dates or a billing service.
      const reconciled = anchorMonth ? asset.revenue : Math.round(asset.revenue * (0.9 + draw(seed, `${asset.id}/${month}/income`) * 0.2));
      const estimate = Math.round(reconciled * (offset === -6 ? 1.04 : 1));
      const estimated = add({ asset: asset.id, period: month, kind: 'revenue', family: asset.revenueFamily, minor: estimate, state: 'estimated', source: 'demo-recorded-income', coverageStart, coverageEnd: monthEnd, coverageComplete: true, recordedAt: `${monthEnd}T22:00:00.000Z` });
      add({ asset: asset.id, period: month, kind: 'revenue', family: asset.revenueFamily, minor: reconciled, state: 'reconciled', source: 'demo-recorded-income', coverageStart, coverageEnd: monthEnd, coverageComplete: true, supersedes: estimated, recordedAt });
    }
  }
  const pulses: DemoPulse[] = [];
  for (const asset of assets.filter(a => !a.isOs)) {
    const rows = daily.filter(d => d.asset === asset.id);
    let total = 0;
    rows.forEach((row, i) => {
      total += row.events;
      const recent = rows.slice(Math.max(0, i - 6), i + 1);
      pulses.push({ asset: asset.id, date: row.date, generatedAt: `${row.date}T23:30:00.000Z`, capabilities: [asset.event!], metrics: { [asset.event!]: { last24h: row.events, avg7d: recent.reduce((sum, r) => sum + r.events, 0) / recent.length, total } } });
    });
  }
  const taskFacts = generateDemoTaskFacts({ assets, seed, referenceDate, cutoff });
  const stories = {
    repair: { asset: assets[0]!.id, findingDate: shiftDemoDay(referenceDate, -60), ref: taskFacts.storyIds.repair, readbackTaskId: taskFacts.storyIds.readback, annotationAt: `${shiftDemoDay(referenceDate, -42)}T12:00:00.000Z`, registeredAt: `${shiftDemoDay(referenceDate, -42)}T00:00:00.000Z`, baselineStart: shiftDemoDay(referenceDate, -70), baselineEnd: shiftDemoDay(referenceDate, -43), checkAt: `${shiftDemoDay(referenceDate, -14)}T23:59:00.000Z`, watchId: 'demo-navigation-repair' },
    problem: { asset: assets[1]!.id, ref: taskFacts.storyIds.problem, date: shiftDemoDay(referenceDate, -2), metric: assets[1]!.event },
  };
  return { manifest: { synthetic: true, scenarioVersion: SCENARIO_VERSION, seed, cutoff, release, timeZone, providerTimeZone: timeZone, referenceDate, referencePeriod, workspaceId, identities: assets.map(({ id, prefix, name, createdAt }) => ({ id, prefix, name, createdAt })), taskProjects: taskFacts.projects, stories }, assets, daily, ledger, pulses, tasks: taskFacts.tasks };
}

export function demoScenarioHash(scenario: DemoScenario) {
  return createHash('sha256').update(JSON.stringify(scenario)).digest('hex');
}

export type DemoScenario = ReturnType<typeof generateDemoScenario>;
