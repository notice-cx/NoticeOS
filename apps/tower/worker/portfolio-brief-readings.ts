import type { PortfolioBriefFact } from '@noticeos/contract/portfolio-brief';
import { currencyMinorDigits } from '@noticeos/contract/money';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import { parseProductSnapshot } from '../shared/product-snapshot';
import { storedWatchScope, watchVerdictFigures } from '../shared/watch-windows';

type Fact = PortfolioBriefFact & { domain: 'finance' | 'product' | 'outcomes' | 'delivery'; basis?: 'current-state' | 'period-observation' };
interface FinanceRow extends Record<string, unknown> { month: string; currency: string; state: string; kind: string; family: string; amount: string; entries: number; recordedAt: string; isTotal: boolean; currencyCount: number; familyCount: number }
interface ProductRow extends Record<string, unknown> { asset: string; generatedAt: string; product: unknown }
interface OutcomeRow extends Record<string, unknown> { asset: string; id: string; metric: string; integration: string; scope: string | null; ref: string; registeredAt: string; nextCheckDate: string | null; readbackTask: string | null; status: string; outcome: string | null; note: string | null; closedAt: string | null; total: number }
interface ChangeRow extends Record<string, unknown> { asset: string; id: number; at: string; kind: string; ref: string; note: string | null; total: number }
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function observationTime(value: string): number | null {
  if (!validDate(value) && !(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && validDate(value.slice(0, 10)))) return null;
  const time = Date.parse(value); return Number.isFinite(time) ? time : null;
}
const DAY = 86_400_000;
const clip = (value: string | null, size = 160) => value?.slice(0, size) ?? null;
const instant = (value: string) => javascriptInstant(value);
const minorAmount = (value: string): number | null => Number.isSafeInteger(Number(value)) ? Number(value) : null;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function monthDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-01`;
}
const shiftMonth = (month: string, delta: number) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1)).toISOString().slice(0, 10);
const monthEnd = (month: string) => new Date(Date.parse(shiftMonth(month, 1)) - DAY).toISOString().slice(0, 10);

/** Four bounded store reads share one upper clock bound; no source is collected here. */
export async function loadPortfolioBriefReadings(store: WorkspaceStore, options: {
  now: Date; assets: readonly { id: string; displayName: string }[]; timeZone: string;
}): Promise<{ facts: PortfolioBriefFact[]; insightEvidenceIds: string[] }> {
  const nowMs = options.now.getTime(), asOf = options.now.toISOString();
  const month = monthDate(options.now, options.timeZone), firstMonth = shiftMonth(month, -2);
  const assets = options.assets.map(asset => asset.id), names = new Map(options.assets.map(asset => [asset.id, asset.displayName]));
  const [finance, products, outcomes, changes] = await Promise.all([
    store.read(tx => tx.query<FinanceRow>(`WITH grouped AS (
      SELECT period_month, currency, booking_state, kind, family, GROUPING(family) = 1 AS "isTotal",
      SUM(amount_minor) AS amount, count(*)::int AS entries, max(recorded_at) AS "recordedAt"
      FROM noticeos.financial_ledger WHERE period_month >= $1::date AND period_month < $2::date AND recorded_at <= $3::timestamptz
      GROUP BY GROUPING SETS ((period_month, currency, booking_state, kind), (period_month, currency, booking_state, kind, family))),
      ranked AS (SELECT *, count(*) FILTER (WHERE NOT "isTotal") OVER (PARTITION BY period_month, currency, booking_state, kind)::int AS "familyCount", dense_rank() OVER (ORDER BY currency) AS currency_rank,
      row_number() OVER (PARTITION BY period_month, currency, booking_state, kind, "isTotal" ORDER BY abs(amount) DESC, family) AS family_rank
      FROM grouped), currencies AS (SELECT count(DISTINCT currency)::int AS n FROM grouped)
      SELECT to_char(period_month, 'YYYY-MM-DD') AS month, currency, booking_state AS state, kind,
      family, amount::text, entries, "recordedAt", "isTotal", "familyCount", currencies.n AS "currencyCount"
      FROM ranked CROSS JOIN currencies WHERE currency_rank <= 6 AND ("isTotal" OR
      (kind = 'cost' AND ((period_month = $4::date AND family_rank <= 5) OR (period_month < $4::date AND EXISTS (SELECT 1 FROM ranked picked WHERE picked.currency = ranked.currency
      AND picked.booking_state = ranked.booking_state AND picked.kind = 'cost' AND NOT picked."isTotal"
      AND picked.period_month < $4::date AND picked.family_rank <= 5 AND picked.family = ranked.family)))))
      ORDER BY period_month DESC, currency, booking_state, kind, "isTotal" DESC, family_rank`, [firstMonth, shiftMonth(month, 1), asOf, month])),
    store.read(tx => tx.query<ProductRow>(`SELECT a.asset_id AS asset, p.generated_at AS "generatedAt", p.payload -> 'product' AS product
      FROM noticeos.assets a CROSS JOIN LATERAL (SELECT payload, generated_at FROM noticeos.asset_insight_snapshots s
      WHERE s.workspace_id = a.workspace_id AND s.asset_id = a.asset_id AND s.generated_at <= $2::timestamptz
      ORDER BY s.generated_at DESC, s.created_at DESC, s.snapshot_id DESC LIMIT 1) p
      WHERE a.asset_id = ANY($1::text[]) ORDER BY p.generated_at DESC, a.asset_id LIMIT 40`, [assets, asOf])),
    store.read(tx => tx.query<OutcomeRow>(`WITH candidates AS (
      SELECT w.asset_id AS asset, w.window_id AS id, w.metric, w.metric_integration AS integration, w.scope::text AS scope,
      w.ref, w.registered_at AS "registeredAt", w.readback_bead AS "readbackTask", w.status, w.outcome,
      w.outcome_note AS note, w.closed_at AS "closedAt",
      ((w.registered_at AT TIME ZONE 'UTC')::date + (SELECT min(offset_days) FROM unnest(w.check_offsets) AS offsets(offset_days)
      WHERE NOT EXISTS (SELECT 1 FROM noticeos.watch_window_readings r WHERE r.workspace_id = w.workspace_id AND r.window_id = w.window_id AND r.offset_days = offsets.offset_days AND r.checked_at <= $2::timestamptz)))::text AS "nextCheckDate"
      FROM noticeos.watch_windows w WHERE w.asset_id = ANY($1::text[]) AND w.registered_at <= $2::timestamptz
      AND (w.status = 'open' OR (w.closed_at >= $3::timestamptz AND w.closed_at <= $2::timestamptz))),
      ranked AS (SELECT *, count(*) OVER ()::int AS total, row_number() OVER (PARTITION BY status
      ORDER BY CASE WHEN status = 'open' THEN "nextCheckDate" END ASC NULLS LAST, "closedAt" DESC NULLS LAST, id) AS rank FROM candidates)
      SELECT * FROM ranked WHERE (status = 'open' AND rank <= 8) OR (status = 'closed' AND rank <= 4)
      ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, "nextCheckDate" NULLS LAST, "closedAt" DESC NULLS LAST, id LIMIT 12`, [assets, asOf, new Date(nowMs - 14 * DAY).toISOString()])),
    store.read(tx => tx.query<ChangeRow>(`SELECT asset_id AS asset, annotation_number::int AS id, at, kind, ref, note,
      count(*) OVER ()::int AS total FROM noticeos.annotations
      WHERE asset_id = ANY($1::text[]) AND at >= $2::timestamptz AND at <= $3::timestamptz
      ORDER BY at DESC, annotation_number DESC LIMIT 10`, [assets, new Date(nowMs - 14 * DAY).toISOString(), asOf])),
  ]);
  const facts: Fact[] = [], insightEvidenceIds: string[] = [];
  const add = (fact: Fact, eligible: boolean) => {
    // Keep oversized source details out rather than emitting an invalid partial object.
    if (bytes(fact) > 1800) {
      fact = { ...fact, data: { asset: fact.data.asset ?? null, detailsOmitted: true, caution: 'Source details exceeded the per-fact size limit; no conclusion is supported by these omitted details.' } };
      eligible = false;
    }
    facts.push(fact); if (eligible) insightEvidenceIds.push(fact.id);
  };
  for (const currency of [...new Set(finance.map(row => row.currency))].slice(0, 6)) for (const state of ['reconciled', 'estimated']) {
    const rows = finance.filter(row => row.currency === currency && row.state === state);
    if (!rows.length) continue;
    const periods = [firstMonth, shiftMonth(month, -1), month].map(period => {
      const current = rows.filter(row => row.month === period && row.isTotal);
      const sum = (kind: string) => {
        const values = current.filter(row => row.kind === kind).map(row => minorAmount(row.amount));
        if (!values.length || values.some(value => value === null)) return null;
        const total = values.reduce<number>((sum, value) => sum + value!, 0);
        return Number.isSafeInteger(total) ? total : null;
      };
      const revenueMinor = sum('revenue'), costMinor = sum('cost');
      return { month: period.slice(0, 7), revenueMinor, costMinor, netMinor: revenueMinor !== null && costMinor !== null ? revenueMinor - costMinor : null };
    });
    const prior = periods[0]!, current = periods[1]!;
    const comparable = state === 'reconciled' && prior.revenueMinor !== null && current.revenueMinor !== null && prior.costMinor !== null && current.costMinor !== null;
    const common = { currency, minorDigits: currencyMinorDigits(currency), bookingState: state, unit: 'minor currency units',
      coveredCurrencies: Math.min(6, rows[0]!.currencyCount), omittedCurrencies: Math.max(0, rows[0]!.currencyCount - 6),
      caution: 'Recorded entries are not complete coverage. Missing kinds and families stay unknown. Estimates are not reconciled profit. No causal attribution.' };
    const costs = (period: string) => rows.filter(row => row.month === period && row.kind === 'cost' && !row.isTotal);
    const historical = rows.filter(row => row.month !== month);
    if (historical.length) {
      const families = [...new Set(historical.filter(row => !row.isTotal && row.kind === 'cost').map(row => row.family))];
      const drivers = families.map(family => {
        const previous = costs(firstMonth).find(row => row.family === family), latest = costs(shiftMonth(month, -1)).find(row => row.family === family);
        const previousMinor = previous ? minorAmount(previous.amount) : null, currentMinor = latest ? minorAmount(latest.amount) : null;
        return { family: clip(family, 60), previousMinor, currentMinor,
          changeMinor: previousMinor !== null && currentMinor !== null && Number.isSafeInteger(currentMinor - previousMinor) ? currentMinor - previousMinor : null,
          classification: previousMinor === null || currentMinor === null ? 'incomplete recorded coverage' : 'recorded cost movement' };
      }).sort((a, b) => Math.abs(b.changeMinor ?? b.currentMinor ?? b.previousMinor ?? 0) - Math.abs(a.changeMinor ?? a.currentMinor ?? a.previousMinor ?? 0) || (a.family ?? '').localeCompare(b.family ?? ''));
      add({ id: `finance:${currency}:${state}:completed`, domain: 'finance', label: `${currency} ${state}: completed months`, href: '/financials', observedAt: asOf,
        period: { start: firstMonth, end: monthEnd(shiftMonth(month, -1)) },
        ...(comparable ? { comparison: { previous: { start: firstMonth, end: monthEnd(firstMonth) }, current: { start: shiftMonth(month, -1), end: monthEnd(shiftMonth(month, -1)) }, timeZone: options.timeZone } } : {}),
        data: { ...common, periods: periods.slice(0, 2), costDrivers: drivers.slice(0, 5), omittedSelectedCostDrivers: Math.max(0, drivers.length - 5),
          costDriverSelection: 'Largest five cost families from either month, with matching recorded values when present; totals include all families.' },
      }, comparable);
    }
    const currentRows = rows.filter(row => row.month === month);
    if (currentRows.length) add({ id: `finance:${currency}:${state}:current`, domain: 'finance', basis: 'current-state',
      label: `${currency} ${state}: current month`, href: '/financials', observedAt: asOf, period: null,
      data: { ...common, accountingMonth: month.slice(0, 7), through: asOf, accounting: periods[2],
        costDrivers: costs(month).sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)) || a.family.localeCompare(b.family)).slice(0, 5).map(row => ({ family: clip(row.family, 60), amountMinor: minorAmount(row.amount), entries: row.entries })),
        omittedCostFamilies: Math.max(0, (currentRows.find(row => row.kind === 'cost' && row.isTotal)?.familyCount ?? 0) - 5),
        caution: `${common.caution} Current month is partial and must not be compared directly with complete-month totals.` },
    }, currencyMinorDigits(currency) !== null && (periods[2]!.revenueMinor !== null || periods[2]!.costMinor !== null));
  }

  for (const row of products) {
    const product = parseProductSnapshot(row.product); if (!product) continue;
    const push = (kind: string, start: string, end: string, data: Record<string, unknown>) => {
      const endMs = Date.parse(end), startMs = Date.parse(start);
      const observedMs = observationTime(product.observedAt);
      const validWindow = validDate(start) && validDate(end) && startMs <= endMs;
      if (!validWindow) return;
      const recent = observedMs !== null && observedMs <= nowMs && endMs <= nowMs && nowMs - endMs <= 7 * DAY;
      add({ id: `product:${row.asset}:${kind}`, domain: 'product', ...(recent ? { basis: 'period-observation' as const } : {}),
        label: `${clip(names.get(row.asset) ?? row.asset, 80)}: ${kind}`, href: `/assets/${encodeURIComponent(row.asset)}`,
        observedAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null, period: { start, end }, data: { asset: row.asset, sourceObservedAt: clip(product.observedAt, 60), publishedAt: instant(row.generatedAt), ...data,
          caution: 'Source reporting window controls freshness; publication time does not. Observed conditions do not establish causes or revenue impact.' } }, recent);
    };
    if (product.exceptions) {
      const item = product.exceptions;
      push('errors', item.windowStart, item.windowEnd, { totalExceptions: item.total, truncated: item.truncated,
        top: [...item.top].sort((a, b) => b.people - a.people || b.count - a.count).slice(0, 3).map(error => ({ type: clip(error.type, 80), people: error.people, count: error.count, sessions: error.sessions, topPath: clip(error.topPath, 100) })) });
    }
    for (const [index, funnel] of [...product.funnels].sort((a, b) => (b.largestDrop?.lostPeople ?? 0) - (a.largestDrop?.lostPeople ?? 0) || a.id.localeCompare(b.id)).slice(0, 2).entries()) push(`funnel:${index}:${funnel.id.slice(0, 40)}`, funnel.windowStart, funnel.windowEnd, {
      name: clip(funnel.name), sampled: funnel.sampled ?? false, conversion: funnel.conversion,
      entrants: funnel.steps[0]?.people ?? null, completions: funnel.steps.at(-1)?.people ?? null,
      steps: funnel.steps.slice(0, 6).map(step => ({ step: step.step, event: clip(step.event, 60), people: step.people })), largestDrop: funnel.largestDrop, prior: funnel.prior && validDate(funnel.prior.windowStart) && validDate(funnel.prior.windowEnd) && funnel.prior.windowStart <= funnel.prior.windowEnd && funnel.prior.windowEnd < funnel.windowStart ? { windowStart: funnel.prior.windowStart, windowEnd: funnel.prior.windowEnd, conversion: funnel.prior.conversion, stepConversion: funnel.prior.stepConversion } : null,
    });
    if (product.vitals) {
      const item = product.vitals;
      push('speed', item.windowStart, item.windowEnd, { minMeasurements: item.minMeasurements, unmeasuredSegments: item.unmeasuredSegments,
        segments: [...item.segments].sort((a, b) => {
          const score = (value: typeof a) => Math.max(value.lcpP75 === null ? 0 : value.lcpP75 / item.lines.lcp.good, value.inpP75 === null ? 0 : value.inpP75 / item.lines.inp.good, value.clsP75 === null ? 0 : value.clsP75 / item.lines.cls.good);
          return score(b) - score(a) || b.measurements - a.measurements;
        }).slice(0, 3).map(segment => ({ ...segment, path: clip(segment.path, 100), device: clip(segment.device, 40), os: clip(segment.os, 40) })) });
    }
  }
  for (const row of outcomes) add({ id: `outcome:${row.id}`, domain: 'outcomes', basis: 'current-state',
    label: `${clip(names.get(row.asset) ?? row.asset, 80)}: ${row.status === 'open' ? 'outcome check' : 'recorded outcome'}`,
    href: `/assets/${encodeURIComponent(row.asset)}`, observedAt: asOf, period: null,
    data: { asset: row.asset, metric: row.metric, integration: row.integration, scope: storedWatchScope(row.scope), ref: clip(row.ref),
      registeredAt: instant(row.registeredAt), status: row.status, nextCheckDate: row.nextCheckDate, readbackTask: clip(row.readbackTask),
      outcome: row.outcome, verdict: clip(watchVerdictFigures(row.note, row.integration, row.metric)), closedAt: row.closedAt ? instant(row.closedAt) : null,
      totalMatchingWindows: row.total, returnedWindows: outcomes.length,
      caution: 'A registered outcome check is not a measured effect. Preserve the stored verdict and scope; no independent causal attribution.' },
  }, true);
  for (const row of changes) add({ id: `change:${row.id}`, domain: 'delivery', label: `${clip(names.get(row.asset) ?? row.asset, 80)}: ${clip(row.kind, 60)}`,
    href: `/assets/${encodeURIComponent(row.asset)}`, observedAt: instant(row.at), period: null,
    data: { asset: row.asset, kind: clip(row.kind, 60), ref: clip(row.ref), note: clip(row.note), totalRecentChanges: row.total,
      caution: 'Supporting chronology only. A nearby metric movement does not establish this change caused it.' } }, false);
  return { facts, insightEvidenceIds };
}
