// Synthetic facts for the ordinary NoticeOS store: scenario choices, not
// estimates of real businesses.
import { createHash } from 'node:crypto';
import { generateDemoTaskFacts } from './demo-task-facts.mjs';

export const SCENARIO_VERSION = 6;
const DAY_MS = 86_400_000;
export interface DemoAsset { id: string; name: string; prefix: string; days: number; sessions: number | null; revenue: number | null; revenueFamily: 'subs' | 'licensing' | null; cost: number; event: string | null; isOs?: boolean;
  /** Ad income per 1,000 sessions, in cents, before season and weekday; only an ad-supported site has one. */
  adRpm?: number;
  /** Only observed, never acted on: the OS itself and a site still setting up. */
  senseOnly?: boolean; }
export interface DemoSite extends DemoAsset { createdAt: string; domain: string | null; status: string; }
/** `reportMissing` is a GA4 day the provider never answered; `pulseMissing`
 * a night the site's own report never arrived. Neither is a zero. */
export interface DemoDay { asset: string; date: string; sessions: number; age: number; pageViews: number; activeUsers: number; events: number; eventCount: number; clicks: number; impressions: number; ctr: number; position: number; reportMissing: boolean; pulseMissing: boolean; provisional: boolean; }
export interface DemoLedger { key: string; currency: string; note: string; asset: string; period: string; kind: 'revenue' | 'cost'; family: string; minor: number; state: 'estimated' | 'reconciled'; source: string; recordedAt: string; coverageStart?: string; coverageEnd?: string; coverageComplete?: boolean; supersedes?: string; }
/** One synthetic daily ad-network estimate, recorded once that day is reported. */
export interface DemoAdDay { asset: string; siteId: string; date: string; minor: number; recordedAt: string; }
export interface DemoPulse { asset: string; date: string; generatedAt: string; capabilities: string[]; metrics: Record<string, { last24h: number; avg7d: number; total: number }>; }
export interface DemoInput { seed: string; cutoff: string; release: string; timeZone?: string; }

/** Five sites with their own shapes: a steady subscription product, a
 * licensed tool, a recipe site growing into its season, an outdoor guide
 * sliding out of its season and a search slump, and a product weeks old. */
export const DEMO_ASSETS: readonly DemoAsset[] = Object.freeze([
  { id: 'lightbrief.example', name: 'Light Brief', prefix: 'lb', days: 400, sessions: 66000, revenue: 180000, revenueFamily: 'subs', cost: 26000, event: 'brief_exports' },
  { id: 'pinwell.example', name: 'Pinwell', prefix: 'pw', days: 400, sessions: 28000, revenue: 52000, revenueFamily: 'licensing', cost: 13000, event: 'source_saves' },
  { id: 'weeknightpantry.example', name: 'Weeknight Pantry', prefix: 'wp', days: 400, sessions: 150000, revenue: null, revenueFamily: null, cost: 9000, event: 'recipe_saves', adRpm: 2400 },
  { id: 'trailnotes.example', name: 'Trail Notes', prefix: 'tn', days: 400, sessions: null, revenue: null, revenueFamily: null, cost: 7000, event: 'route_downloads', adRpm: 2100 },
  { id: 'freshrows.example', name: 'Fresh Rows', prefix: 'fr', days: 24, sessions: null, revenue: null, revenueFamily: null, cost: 6000, event: 'completed_checks', senseOnly: true },
  { id: 'noticeos', name: 'NoticeOS', prefix: 'no', days: 400, sessions: null, revenue: null, revenueFamily: null, cost: 21000, event: null, isOs: true, senseOnly: true },
]);

/** The outdoor guide's slide: search visibility lost over its last
 * `DEMO_SLIDE_DAYS` days, to `1 − DEMO_SLIDE_DEPTH` of its level, and the
 * redesign `DEMO_REDESIGN_AGE` days before the reference day cost a further
 * step. Scenario choices; the outcome check measures them like any change. */
export const DEMO_SLIDE_DAYS = 110;
export const DEMO_SLIDE_DEPTH = 0.3;
export const DEMO_REDESIGN_AGE = -36;
/** Light Brief's nightly report stops this many days before the reference
 * day; the simulator's recurring gaps continue the same cadence. */
export const DEMO_REPORT_GAP_DAYS = 2;

export function shiftDemoDay(day: string, offset: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

export function shiftDemoMonth(period: string, offset: number) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 7);
}

/** Each site's demand by weekday, Sunday first: software is used on workdays,
 * recipes are cooked and trails walked at weekends. The simulator continues
 * the same shape. */
export function demoWeekShape(prefix: string): readonly number[] {
  return prefix === 'wp' ? [1.24, 0.98, 0.95, 0.96, 0.98, 0.9, 1.06]
    : prefix === 'tn' ? [1.34, 0.86, 0.84, 0.86, 0.9, 0.98, 1.42]
      : [0.82, 1.08, 1.08, 1.08, 1.08, 1.08, 0.82];
}

/** How a visit turns into pages, users, tracked actions and search results.
 * A content site: more pages a visit, more of it from search, higher in results. */
export function demoTrafficShape(prefix: string) {
  return prefix === 'wp'
    ? { pages: 2.2, pagesSpread: 0.4, activeUsers: 0.84, events: 0.035, clicks: 0.66, impressionsPerClick: 21, position: 4, positionSpread: 1.5 }
    : prefix === 'tn'
      ? { pages: 2.6, pagesSpread: 0.5, activeUsers: 0.86, events: 0.05, clicks: 0.7, impressionsPerClick: 24, position: 7, positionSpread: 2.5 }
      : { pages: 1.55, pagesSpread: 0.3, activeUsers: 0.79, events: 0.065, clicks: 0.57, impressionsPerClick: 18, position: 6, positionSpread: 2 };
}

/** A content site's year: demand is `1 + amplitude × cos(angle)`, peaking on
 * day `peakDay` — recipes in late November, trails in mid-July. The
 * simulator continues with the gentler `continuing` amplitude. */
export function demoSeason(prefix: string): { peakDay: number; amplitude: number; continuing: number } | null {
  return prefix === 'wp' ? { peakDay: 328, amplitude: 0.22, continuing: 0.22 }
    : prefix === 'tn' ? { peakDay: 196, amplitude: 0.3, continuing: 0.12 } : null;
}
export function demoSeasonAngle(date: string, peakDay: number): number {
  const dayOfYear = (Date.parse(`${date}T00:00:00Z`) - Date.UTC(Number(date.slice(0, 4)), 0, 1)) / DAY_MS;
  return 2 * Math.PI * (dayOfYear - peakDay) / 365.25;
}

/** The outdoor guide's level at `age` days from the reference day, before
 * season and noise: the slide, then the redesign's step. */
export function demoSlide(age: number): number {
  const slid = age < -DEMO_SLIDE_DAYS ? 1 : 1 - DEMO_SLIDE_DEPTH * ((age + DEMO_SLIDE_DAYS) / DEMO_SLIDE_DAYS) ** 1.2;
  return slid * (age >= DEMO_REDESIGN_AGE ? 0.93 : 1);
}

/** The ad network's site identity for a fictional ad-supported site. */
export function demoAdSiteId(asset: Pick<DemoAsset, 'prefix'>): string {
  return `demo-${asset.prefix}`;
}

/** The sites that read Bing as well as Google: the two content sites. */
const BING_SITES: readonly string[] = ['wp', 'tn'];
/** Bing's share of a content site's search clicks and impressions. */
export const DEMO_BING_SHARE = 0.09;

/** Each site's properties as its synthetic sources name them: a GA4
 * property id, a Search Console domain property and, for a content site, a
 * Bing site. Signal runs and the saved register use the same references. */
export function demoProperties(asset: Pick<DemoAsset, 'id' | 'prefix'>): { ga4: string; gsc: string; bing: string | null } {
  const index = DEMO_ASSETS.findIndex(entry => entry.prefix === asset.prefix);
  if (index < 0) throw new Error('Demo properties need a declared site.');
  return { ga4: String(381204401 + index), gsc: `sc-domain:${asset.id}`, bing: BING_SITES.includes(asset.prefix) ? `https://${asset.id}/` : null };
}

/** Ad income per 1,000 sessions by month: an autumn ramp to a December peak and
 * a January trough, as ad markets move. Invented scenario values. */
const AD_SEASON = [0.78, 0.84, 0.9, 0.94, 0.97, 0.98, 0.95, 0.97, 1.02, 1.12, 1.3, 1.45] as const;

/** One day's synthetic ad estimate in cents. Ad income follows visits; the
 * subscription and licensing income above never does. */
export function demoAdRevenueMinor(seed: string, asset: Pick<DemoAsset, 'id' | 'adRpm'>, date: string, sessions: number): number {
  if (!asset.adRpm || !Number.isSafeInteger(sessions) || sessions < 0) throw new Error('Ad revenue needs an ad-supported site and its sessions.');
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const noise = 0.94 + draw(seed, `${asset.id}/${date}/rpm`) * 0.12;
  return Math.round(sessions * asset.adRpm * AD_SEASON[Number(date.slice(5, 7)) - 1]! * (weekday === 0 || weekday === 6 ? 0.93 : 1.02) * noise / 1000);
}

/** A month of ad estimates is paid on the sixth of the second month after it,
 * close to but rarely exactly the estimates' sum. */
export function demoAdPayment(seed: string, asset: Pick<DemoAsset, 'id'>, month: string, dailyMinor: readonly number[]): { minor: number; paidOn: string } {
  const sum = dailyMinor.reduce((a, b) => a + b, 0);
  return { minor: Math.round(sum * (0.985 + draw(seed, `${asset.id}/${month}/payment`) * 0.03)), paidOn: `${shiftDemoMonth(month, 2)}-06` };
}

/** The last day an ad network has reported by `instant`: yesterday once the
 * morning report is in (14:10 UTC is after it in every season), otherwise the
 * day before. */
export function demoAdReportedThrough(instant: string): string {
  const day = instant.slice(0, 10);
  return shiftDemoDay(day, instant >= `${day}T14:10:00.000Z` ? -1 : -2);
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
  const referencePeriod = shiftDemoMonth(shiftDemoDay(referenceDate, -70).slice(0, 7), -1);
  const identity = createHash('sha256').update(JSON.stringify({ seed, cutoff, release, timeZone, version: SCENARIO_VERSION })).digest('hex');
  const workspaceId: `${string}-${string}-${string}-${string}-${string}` = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  const assets = DEMO_ASSETS.map(a => ({ ...a, id: a.isOs ? `os-${identity.slice(32, 48)}` : a.id, createdAt: `${shiftDemoDay(referenceDate, -a.days)}T00:00:00.000Z`, domain: a.isOs ? null : a.id, status: a.days === 24 ? 'baselining' : 'live' }));
  const daily: DemoDay[] = [];
  for (const asset of assets.filter(a => !a.isOs)) {
    const rows: DemoDay[] = [];
    const season = demoSeason(asset.prefix);
    const recipes = asset.prefix === 'wp', trails = asset.prefix === 'tn';
    for (let age = -asset.days; age < 0; age++) {
      const date = shiftDemoDay(referenceDate, age);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const annual = season ? Math.cos(demoSeasonAngle(date, season.peakDay)) : Math.sin(2 * Math.PI * (Date.parse(`${date}T00:00:00Z`) / DAY_MS % 365.25) / 365.25);
      const ownWeek = demoWeekShape(asset.prefix)[weekday]!;
      const noise = 0.92 + draw(seed, `${asset.id}/${date}/demand`) * 0.16;
      const shared = 0.96 + draw(seed, `${date}/shared-demand`) * 0.08;
      const trend = asset.days === 24 ? (1 + (24 + age) * 0.027)
        : trails ? (1 + (400 + age) * 0.0002) * demoSlide(age)
          : (1 + (400 + age) * (recipes ? 0.0006 : 0.00015));
      const referralSpike = !season && age >= -95 && age <= -93;
      const repair = asset.prefix === 'lb' && age >= -60 && age <= -43;
      // The recipe site's faster pages shipped a week before the reference day
      // (`manifest.ship`): a modest lift, still inside its 28-day comparison.
      const faster = recipes && age >= -7;
      const base = asset.days === 24 ? 18 : asset.prefix === 'lb' ? 2000 : recipes ? 5000 : trails ? 3300 : 820;
      const amplitude = season ? season.amplitude : asset.prefix === 'pw' ? 0.2 : 0.09;
      const traffic = Math.max(1, Math.round(base * ownWeek * (1 + annual * amplitude) * noise * shared * trend * (referralSpike ? 1.7 : 1) * (repair ? 0.68 : 1) * (faster ? 1.09 : 1)));
      rows.push({ pageViews: 0, activeUsers: 0, events: 0, eventCount: 0, clicks: 0, impressions: 0, ctr: 0, position: 0, reportMissing: false, pulseMissing: false, provisional: false, asset: asset.id, date, sessions: traffic, age });
    }
    // This completed month is the brief's exact readable accounting anchor.
    const anchor = rows.filter(r => r.date.startsWith(referencePeriod));
    if (asset.sessions !== null) {
      const counts = allocate(asset.sessions, anchor.map(r => r.sessions));
      anchor.forEach((r, i) => { r.sessions = counts[i]!; });
    }
    const shape = demoTrafficShape(asset.prefix);
    for (const row of rows) {
      // Pinwell's saves broke two days ago and are still broken; the recipe
      // site's saves failed for one day and came back the next.
      const rate = asset.prefix === 'pw' && row.age >= -2 ? 0.001 : recipes && row.age === -2 ? shape.events * 0.15 : shape.events;
      row.pageViews = Math.round(row.sessions * (shape.pages + draw(seed, `${asset.id}/${row.date}/pages`) * shape.pagesSpread));
      row.activeUsers = Math.max(1, Math.round(row.sessions * shape.activeUsers));
      row.events = Math.round(row.sessions * rate);
      row.eventCount = row.pageViews + row.sessions + row.events;
      row.clicks = Math.round(row.sessions * shape.clicks);
      row.impressions = row.clicks * shape.impressionsPerClick + Math.round(draw(seed, `${asset.id}/${row.date}/search`) * 100);
      row.ctr = row.clicks / row.impressions;
      row.position = Math.round((shape.position + draw(seed, `${asset.id}/${row.date}/position`) * shape.positionSpread) * 100) / 100;
      row.reportMissing = asset.prefix === 'pw' && row.age === -5;
      row.pulseMissing = asset.prefix === 'lb' && row.age >= -DEMO_REPORT_GAP_DAYS;
      // GA4 keeps yesterday provisional until it is collected again.
      row.provisional = row.age >= -1;
      daily.push(row);
    }
  }
  // Ad estimates for every recorded day; the store holds those reported by the cutoff.
  const adDays = new Map<string, number>();
  for (const asset of assets.filter(a => a.adRpm)) {
    for (const row of daily.filter(d => d.asset === asset.id)) adDays.set(`${asset.id}/${row.date}`, demoAdRevenueMinor(seed, asset, row.date, row.sessions));
  }
  const reportedThrough = demoAdReportedThrough(cutoff);
  const adRevenue: DemoAdDay[] = assets.filter(a => a.adRpm).flatMap(asset => daily
    .filter(d => d.asset === asset.id && d.date <= reportedThrough)
    .map(d => ({ asset: asset.id, siteId: demoAdSiteId(asset), date: d.date, minor: adDays.get(`${asset.id}/${d.date}`)!,
      recordedAt: `${shiftDemoDay(d.date, 1)}T14:10:00.000Z` })));
  const ledger: DemoLedger[] = [];
  const add = (row: Omit<DemoLedger, 'key' | 'currency' | 'note'>, note = 'Synthetic demo accounting.') => { const value = { key: `ledger-${ledger.length + 1}`, currency: 'USD', note, ...row }; ledger.push(value); return value.key; };
  for (let offset = -12; offset <= 0; offset++) {
    const month = shiftDemoMonth(period, offset);
    const anchorMonth = month === referencePeriod;
    const monthEnd = shiftDemoDay(`${shiftDemoMonth(month, 1)}-01`, -1);
    const recordedAt = offset === 0 ? cutoff : `${monthEnd}T23:00:00.000Z`;
    for (const asset of assets) {
      if (asset.createdAt.slice(0, 10) > monthEnd) continue;
      const cost = asset.prefix === 'fr' ? asset.cost : Math.round(asset.cost * (anchorMonth ? 1 : 0.94 + draw(seed, `${asset.id}/${month}/cost`) * 0.12));
      add({ asset: asset.id, period: month, kind: 'cost', family: asset.isOs ? 'os-overhead' : 'infra', minor: cost, state: 'reconciled', source: 'demo', recordedAt }, offset === 0 ? 'Synthetic prepaid operating bill recorded this month.' : 'Synthetic demo accounting.');
      if (asset.adRpm) {
        // Months paid before the reference day are reconciled; later months
        // stay the network's daily estimates until their payment arrives.
        const dates = daily.filter(d => d.asset === asset.id && d.date.startsWith(month)).map(d => d.date);
        const payment = demoAdPayment(seed, asset, month, dates.map(date => adDays.get(`${asset.id}/${date}`)!));
        if (dates.length && monthEnd < referenceDate && payment.paidOn < referenceDate) {
          add({ asset: asset.id, period: month, kind: 'revenue', family: 'ads', minor: payment.minor, state: 'reconciled', source: 'mediavine',
            coverageStart: `${month}-01`, coverageEnd: monthEnd, coverageComplete: true, recordedAt: `${payment.paidOn}T15:00:00.000Z` },
          'Synthetic ad network payment; no real payout.');
        }
      }
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
      // A night with no report sends no envelope; the site's own all-time
      // counter keeps counting, so the next report's total includes it.
      total += row.events;
      if (row.pulseMissing) return;
      const recent = rows.slice(Math.max(0, i - 6), i + 1);
      pulses.push({ asset: asset.id, date: row.date, generatedAt: `${row.date}T23:30:00.000Z`, capabilities: [asset.event!], metrics: { [asset.event!]: { last24h: row.events, avg7d: recent.reduce((sum, r) => sum + r.events, 0) / recent.length, total } } });
    });
  }
  const taskFacts = generateDemoTaskFacts({ assets, seed, referenceDate, cutoff });
  const site = (prefix: string) => assets.find(asset => asset.prefix === prefix)!;
  const day = (offset: number, time: string) => `${shiftDemoDay(referenceDate, offset)}T${time}.000Z`;
  const stories = {
    repair: { asset: site('lb').id, findingDate: shiftDemoDay(referenceDate, -60), ref: taskFacts.storyIds.repair, readbackTaskId: taskFacts.storyIds.readback, annotationAt: day(-42, '12:00:00'), registeredAt: day(-42, '00:00:00'), baselineStart: shiftDemoDay(referenceDate, -70), baselineEnd: shiftDemoDay(referenceDate, -43), checkAt: day(-14, '23:59:00'), watchId: 'demo-navigation-repair' },
    problem: { asset: site('pw').id, ref: taskFacts.storyIds.problem, date: shiftDemoDay(referenceDate, -2), metric: site('pw').event },
  };
  // A change shipped a week ago with its comparison still counting: the
  // recipe site's faster pages, annotated when its task closed and watched on
  // sessions for 28 days against the 28 days before it. No outcome is claimed.
  const ship = { asset: site('wp').id, ref: taskFacts.storyIds.ship, readbackTaskId: taskFacts.storyIds.shipReadback, annotationAt: day(-7, '15:00:00'), registeredAt: day(-7, '00:00:00'), baselineStart: shiftDemoDay(referenceDate, -35), baselineEnd: shiftDemoDay(referenceDate, -8), checkOffsets: [28], watchId: 'demo-faster-recipe-pages' };
  // The outdoor guide's redesign shipped into its slide. Its comparison
  // reached its final check eight days ago; the release's evaluator reads it
  // from the stored sessions, and the verdict is whatever that reading says.
  const slide = { asset: site('tn').id, ref: taskFacts.storyIds.slide, readbackTaskId: taskFacts.storyIds.slideReadback, annotationAt: day(DEMO_REDESIGN_AGE, '15:00:00'), registeredAt: day(DEMO_REDESIGN_AGE, '00:00:00'), baselineStart: shiftDemoDay(referenceDate, DEMO_REDESIGN_AGE - 28), baselineEnd: shiftDemoDay(referenceDate, DEMO_REDESIGN_AGE - 1), checkAt: day(DEMO_REDESIGN_AGE + 28, '23:59:00'), watchId: 'demo-trail-redesign' };
  // The recipe site's saves failed for one day; its next report was back to
  // normal, which closed the alert. Pinwell's repair shipped hours ago, after
  // its last report, so its alert stays open until a report says otherwise.
  const dip = { asset: site('wp').id, date: shiftDemoDay(referenceDate, -2), metric: site('wp').event, resolvedAt: day(-1, '23:30:00') };
  const fix = { asset: site('pw').id, ref: taskFacts.storyIds.problem, annotationAt: new Date(Date.parse(cutoff) - 4 * 3_600_000).toISOString() };
  const reportGap = { asset: site('lb').id, from: shiftDemoDay(referenceDate, -DEMO_REPORT_GAP_DAYS) };
  const adSites = assets.filter(a => a.adRpm).map(asset => ({ asset: asset.id, siteId: demoAdSiteId(asset) }));
  return { manifest: { synthetic: true, scenarioVersion: SCENARIO_VERSION, seed, cutoff, release, timeZone, providerTimeZone: timeZone, referenceDate, referencePeriod, workspaceId, identities: assets.map(({ id, prefix, name, createdAt }) => ({ id, prefix, name, createdAt })), taskProjects: taskFacts.projects, adSites, stories, ship, slide, dip, fix, reportGap }, assets, daily, ledger, adRevenue, pulses, tasks: taskFacts.tasks };
}

/** A day's counts as each source reports them. */
export function demoSourceValues(row: DemoDay, integration: 'ga4' | 'gsc' | 'bing-webmaster'): Record<string, number> {
  if (integration === 'ga4') return { sessions: row.sessions, active_users: row.activeUsers, page_views: row.pageViews, event_count: row.eventCount };
  if (integration === 'gsc') return { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position };
  return { clicks: Math.round(row.clicks * DEMO_BING_SHARE), impressions: Math.round(row.impressions * DEMO_BING_SHARE) };
}

export function demoScenarioHash(scenario: DemoScenario) {
  return createHash('sha256').update(JSON.stringify(scenario)).digest('hex');
}

export type DemoScenario = ReturnType<typeof generateDemoScenario>;
