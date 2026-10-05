/** Ledger currency and integer minor-unit arithmetic. No exchange rates. */
const currencies = new Set(Intl.supportedValuesOf('currency'));
const precision = new Map<string, number>();

/** The current runtime's supported currency inventory, rather than Intl's
 * permissive three-letter fallback (which invents two digits for unknowns). */
export function isSupportedCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) && currencies.has(value);
}

export function currencyMinorDigits(currency: string): number | null {
  if (!isSupportedCurrency(currency)) return null;
  const known = precision.get(currency);
  if (known !== undefined) return known;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 0) return null;
  precision.set(currency, digits);
  return digits;
}

/** Convert the number's round-tripping decimal exactly, including exponent
 * notation. Additional precision rounds half away from zero. */
export function majorToMinorUnits(amount: number, currency = 'USD'): number {
  const digits = currencyMinorDigits(currency);
  if (digits === null || !Number.isFinite(amount)) return Number.NaN;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(amount));
  if (!match) return Number.NaN;
  const fraction = match[3] ?? '';
  const coefficient = BigInt(match[2]! + fraction);
  const scale = fraction.length - Number(match[4] ?? 0) - digits;
  let minor: bigint;
  if (scale <= 0) minor = coefficient * 10n ** BigInt(-scale);
  else {
    const divisor = 10n ** BigInt(scale);
    minor = coefficient / divisor + (2n * (coefficient % divisor) >= divisor ? 1n : 0n);
  }
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return Number.NaN;
  return Number(minor) * (match[1] === '-' ? -1 : 1);
}

export function minorToMajorUnits(amount: number, currency: string): number {
  const digits = currencyMinorDigits(currency);
  if (digits === null || !Number.isSafeInteger(amount)) return Number.NaN;
  return amount / 10 ** digits;
}

export type MoneyFigure =
  | { readonly currency: string; readonly revenue: number; readonly cost: number; readonly net: number }
  | { readonly currency: null; readonly revenue: null; readonly cost: null; readonly net: null };

export const UNAVAILABLE_MONEY: MoneyFigure = Object.freeze({ currency: null, revenue: null, cost: null, net: null });

export interface MinorMoneyFigure {
  readonly currency: string;
  readonly revenueMinor: number;
  readonly costMinor: number;
}

/** SQL callers group by currency before handing us a semantic aggregate.
 * Empty groups retain their explicit currency; mixed/unsafe groups state none. */
export function moneyFigure(rows: readonly MinorMoneyFigure[], emptyCurrency = 'USD'): MoneyFigure {
  const currency = rows[0]?.currency ?? emptyCurrency;
  if (!isSupportedCurrency(currency) || rows.some(row => row.currency !== currency
    || !Number.isSafeInteger(row.revenueMinor) || !Number.isSafeInteger(row.costMinor))) return UNAVAILABLE_MONEY;
  let revenue = 0n, cost = 0n;
  for (const row of rows) {
    revenue += BigInt(row.revenueMinor);
    cost += BigInt(row.costMinor);
  }
  const safe = (amount: bigint) => amount >= -BigInt(Number.MAX_SAFE_INTEGER) && amount <= BigInt(Number.MAX_SAFE_INTEGER);
  if (![revenue, cost, revenue - cost].every(safe)) return UNAVAILABLE_MONEY;
  return Object.freeze({ currency, revenue: minorToMajorUnits(Number(revenue), currency),
    cost: minorToMajorUnits(Number(cost), currency), net: minorToMajorUnits(Number(revenue - cost), currency) });
}


/** A comparison or total is meaningful only when every figure states the same currency. */
export function moneyCurrency(figures: readonly MoneyFigure[]): string | null {
  const currency = figures[0]?.currency ?? 'USD';
  return currency !== null && figures.every(figure => figure.currency === currency) ? currency : null;
}

export function sumMoneyFigures(figures: readonly MoneyFigure[]): MoneyFigure {
  const currency = moneyCurrency(figures);
  if (currency === null) return UNAVAILABLE_MONEY;
  return moneyFigure(figures.map(figure => ({ currency,
    revenueMinor: majorToMinorUnits(figure.revenue!, currency),
    costMinor: majorToMinorUnits(figure.cost!, currency) })), currency);
}
