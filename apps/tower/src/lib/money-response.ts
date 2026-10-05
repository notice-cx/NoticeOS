import { isSupportedCurrency, type MoneyFigure } from '@noticeos/contract/money';
import type { FinancialsPayload } from '@shared/financials';
import type { WallPayload } from '@shared/wall';
import { ASSET_VIEW_SECTIONS, isAssetDetailView, type AssetDetailResponse, type AssetDetailView } from '@shared/asset-detail-views';
import {
  responseRecord as record, responseString as string, responseNumber as number, responseInteger as integer,
  responseBoolean as boolean, responseNullable as nullable, responseList as list, responseEnum as oneOf,
  responseDay as day, responseMonth as month, responseInstant as instant, responseZone as zone, responseFields as fields, invalidResponse,
} from './response-value';

const minor = (value: unknown) => number(value) && Number.isSafeInteger(value);
const unique = (values: unknown[], key?: string) => new Set(values.map(value => key && record(value) ? value[key] : value)).size === values.length;

/** Each aggregate states its own currency. An unavailable sum is wholly null. */
export function moneyFigureValue(value: unknown): value is MoneyFigure {
  return fields(value, { currency: isSupportedCurrency, revenue: number, cost: number, net: number })
    || fields(value, { currency: item => item === null, revenue: item => item === null,
      cost: item => item === null, net: item => item === null });
}

export function moneyLine(value: unknown): boolean {
  return fields(value, { amount: number, currency: isSupportedCurrency });
}

/** Stored provider estimates use signed USD minor units; zero is an observation. */
export function dailyRevenueHistory(value: unknown): boolean {
  return fields(value, { from: day, to: day, reportedThrough: nullable(day),
    days: list(item => fields(item, { date: day, amountMinor: minor }, { currency: currency => currency === 'USD' })) },
    { currency: currency => currency === 'USD' })
    && typeof value.from === 'string' && typeof value.to === 'string'
    && (value.from <= value.to || Array.isArray(value.days) && value.days.length === 0 && value.reportedThrough === null)
    && Array.isArray(value.days) && unique(value.days, 'date')
    && value.days.every(item => record(item) && string(item.date) && item.date >= (value.from as string) && item.date <= (value.to as string));
}

export function dailyRevenueSummary(value: unknown): boolean {
  return fields(value, { date: day, amountMinor: nullable(minor), reportedThrough: nullable(day), timeZone: zone },
    { currency: currency => currency === 'USD' });
}

export function portfolioDailyRevenue(value: unknown): boolean {
  if (!dailyRevenueHistory(value) || !fields(value, {
    sources: list(item => fields(item, { asset: string, displayName: string, since: day })),
    coverage: list(item => fields(item, { date: day, reported: integer, missingAssets: list(string) })),
  }) || !Array.isArray(value.sources) || !Array.isArray(value.coverage)) return false;
  const assets = new Set(value.sources.map(item => (item as { asset: string }).asset));
  return assets.size === value.sources.length && unique(value.coverage, 'date')
    && value.coverage.every(item => record(item) && string(item.date)
      && item.date >= (value.from as string) && item.date <= (value.to as string)
      && integer(item.reported) && item.reported <= assets.size
      && Array.isArray(item.missingAssets) && unique(item.missingAssets)
      && item.missingAssets.every(asset => assets.has(asset)));
}

/** Validate the received forecast, never recalculate it or fill its gaps. */
export function revenueProjection(value: unknown): boolean {
  return fields(value, {
    period: month, previousPeriod: month,
    status: oneOf(['ready', 'no-revenue', 'waiting-revenue', 'waiting-traffic', 'insufficient-history', 'unmatched-traffic']),
    reason: nullable(string), reportedThrough: nullable(day), earnedMinor: nullable(minor), projectedMinor: nullable(minor),
    dailyPaceMinor: nullable(minor), previousMonthMinor: nullable(minor), changePercent: nullable(number),
    historyDays: integer, holidayHistoryDays: integer,
    points: list(item => fields(item, { date: day, cumulativeMinor: minor, projected: boolean }, { currency: currency => currency === 'USD' })),
  }, { currency: currency => currency === 'USD' }) && Array.isArray(value.points) && unique(value.points, 'date')
    && value.points.every(item => record(item) && string(item.date) && item.date.slice(0, 7) === value.period);
}

const usd = (value: unknown) => value === 'USD';
const currency = nullable(isSupportedCurrency);
function trend(points: unknown, basis: unknown, date: (value: unknown) => boolean): boolean {
  return currency(basis) && list(item => fields(item, { t: date, v: nullable(number) }))(points)
    && Array.isArray(points) && unique(points, 't')
    && (basis !== null || points.every(item => record(item) && item.v === null));
}

/** Only received money is validated. No totals, conversions or gaps are inferred. */
export function decodeFinancials(value: unknown, requestedPeriod?: string | null): FinancialsPayload {
  const periodFigure = (item: unknown) => fields(item, { period: month, figure: nullable(moneyFigureValue) });
  if (!fields(value, {
    generatedAt: instant, period: month, periods: list(month), periodIsCurrent: boolean, currentPeriod: month, empty: boolean,
    months: list(item => fields(item, { period: month, booked: moneyFigureValue, estimated: moneyFigureValue, total: moneyFigureValue })),
    properties: list(item => fields(item, { asset: string, displayName: string, isOs: boolean, figure: moneyFigureValue,
      months: list(periodFigure), revenueReported: boolean })),
    overhead: moneyFigureValue,
    costLines: list(item => moneyLine(item) && fields(item, { family: string,
      provenance: oneOf(['metered', 'stated', 'amortized', 'unclassified']), source: nullable(string), rows: integer })),
    domains: list(item => fields(item, { domain: string, asset: string, paidUsd: number, paidOn: day,
      perMonth: number, firstPeriod: month, lastPeriod: month }, { currency: usd })),
    recurringCosts: list(item => fields(item, { id: string, label: string, asset: string, family: string, amountUsdPerMonth: number, from: month },
      { to: month, note: string, currency: usd })),
    domainOrders: list(item => fields(item, { domain: string, asset: string, kind: string, paidUsd: number, paidOn: day }, { currency: usd })),
  }, { dailyRevenue: portfolioDailyRevenue }) || requestedPeriod && value.period !== requestedPeriod
    || !Array.isArray(value.properties) || !unique(value.properties, 'asset')) invalidResponse('Financials');
  return value as unknown as FinancialsPayload;
}

function portfolio(value: unknown): boolean {
  return fields(value, { period: month, periodIsCurrent: boolean, booked: moneyFigureValue, forecast: moneyFigureValue,
    residue: item => fields(item, { booked: moneyFigureValue, forecast: moneyFigureValue }),
    netTrend: list(item => fields(item, { t: item => day(item) || month(item), v: nullable(number) })),
    netTrendAll: list(item => fields(item, { t: item => day(item) || month(item), v: nullable(number) })),
    netTrendCurrency: currency, netTrendAllCurrency: currency, trendGranularity: oneOf(['monthly', 'daily']),
    bookedDelta: nullable(item => fields(item, { currency: isSupportedCurrency, value: number, percent: nullable(number), period: month, priorPeriod: month })),
    firstRun: boolean, daysIn: integer,
  }, { revenueRecorded: item => fields(item, { booked: boolean, forecast: boolean }) })
    && trend(value.netTrend, value.netTrendCurrency, value.trendGranularity === 'monthly' ? month : day)
    && trend(value.netTrendAll, value.netTrendAllCurrency, value.trendGranularity === 'monthly' ? month : day);
}

export function decodeWallMoney(value: unknown): WallPayload {
  if (!fields(value, { generatedAt: instant, portfolio,
    assets: list(item => fields(item, { id: string, booked: moneyFigureValue, forecast: moneyFigureValue, netPeriod: month,
      netByMonth: list(point => fields(point, { t: month, v: nullable(number) })),
      netByMonthCurrency: currency, netByMonthProvisionalFrom: nullable(month),
    }, { dailyRevenue: dailyRevenueSummary, revenueProjection })
      && trend(item.netByMonth, item.netByMonthCurrency, month)),
    ledgerRecordedAt: nullable(instant),
  }) || !Array.isArray(value.assets) || !unique(value.assets, 'id')) invalidResponse('Portfolio money');
  return value as unknown as WallPayload;
}

function ledger(value: unknown): boolean {
  const rollup = (item: unknown) => fields(item, { figure: moneyFigureValue,
    revenueByFamily: list(line => moneyLine(line) && fields(line, { family: string })),
    costByFamily: list(line => moneyLine(line) && fields(line, { family: string })),
  });
  return fields(value, { currency, empty: boolean,
    periods: list(item => fields(item, { period: month, booked: rollup, forecast: rollup })),
    recentRows: list(item => moneyLine(item) && fields(item, { id: id => minor(id) && id !== 0,
      kind: oneOf(['revenue', 'cost']), period: month, family: string, bookingState: oneOf(['estimated', 'reconciled']),
      source: nullable(string), ref: nullable(string), note: nullable(string), recordedAt: instant })),
  });
}

export function decodeAssetMoney(value: unknown, requestedAsset: string, requestedView?: AssetDetailView): AssetDetailResponse {
  const needsLedger = requestedView === undefined || ASSET_VIEW_SECTIONS[requestedView].some(section => section === 'ledger');
  if (!fields(value, { generatedAt: instant, asset: item => fields(item, { id: id => id === requestedAsset }),
    osTimeZone: zone, integrations: item => fields(item, {
      lanes: list(lane => fields(lane, { catalog: catalog => fields(catalog, { id: string, label: string }) })),
    }),
  }, { ledger, dailyRevenue: dailyRevenueHistory, view: nullable(item => string(item) && isAssetDetailView(item)) })
    || needsLedger && !Object.hasOwn(value, 'ledger')
    || value.view != null && value.view !== requestedView) invalidResponse('Site financials');
  return value as unknown as AssetDetailResponse;
}
