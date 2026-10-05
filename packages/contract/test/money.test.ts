import { describe, expect, it } from 'vitest';
import { currencyMinorDigits, isSupportedCurrency, majorToMinorUnits, minorToMajorUnits, moneyFigure, moneyCurrency, sumMoneyFigures } from '../src/money';

describe('stated currency minor units', () => {
  it('recognizes supported uppercase codes and refuses Intl unknown-code fallback', () => {
    for (const currency of ['USD', 'EUR', 'JPY', 'KWD']) expect(isSupportedCurrency(currency)).toBe(true);
    for (const currency of ['usd', 'XYZ', '', 'EUR ', null, {}, 123]) expect(isSupportedCurrency(currency)).toBe(false);
    expect(currencyMinorDigits('USD')).toBe(2);
    expect(currencyMinorDigits('JPY')).toBe(0);
    expect(currencyMinorDigits('KWD')).toBe(3);
    expect(currencyMinorDigits('XYZ')).toBeNull();
  });
  it.each([
    [168.2, 'USD', 16820], [10.005, 'EUR', 1001], [-10.005, 'EUR', -1001],
    [10.5, 'JPY', 11], [-10.5, 'JPY', -11], [1.2345, 'KWD', 1235], [-1.2345, 'KWD', -1235],
    [1e-7, 'USD', 0], [-1e-7, 'KWD', -0],
  ])('converts %s %s exactly to %s minor units', (major, currency, minor) => {
    expect(majorToMinorUnits(major, currency)).toBe(minor);
  });
  it('rejects unsafe, non-finite and unknown-currency input', () => {
    for (const amount of [Number.POSITIVE_INFINITY, Number.NaN, 1e25]) expect(majorToMinorUnits(amount)).toBeNaN();
    expect(majorToMinorUnits(10, 'XYZ')).toBeNaN();
    expect(minorToMajorUnits(1235, 'KWD')).toBe(1.235);
    expect(minorToMajorUnits(1235, 'JPY')).toBe(1235);
  });
  it('subtracts integer units before display and never adds different currencies', () => {
    expect(moneyFigure([{ currency: 'EUR', revenueMinor: 180965, costMinor: 86640 }])).toEqual({ currency: 'EUR', revenue: 1809.65, cost: 866.4, net: 943.25 });
    expect(moneyFigure([{ currency: 'EUR', revenueMinor: 100, costMinor: 0 }, { currency: 'USD', revenueMinor: 100, costMinor: 0 }])).toEqual({ currency: null, revenue: null, cost: null, net: null });
    expect(moneyFigure([])).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(moneyFigure([{ currency: 'USD', revenueMinor: Number.MAX_SAFE_INTEGER, costMinor: -1 }]).net).toBeNull();
  });
});


it('does not combine unlike major-unit figures or mark an unavailable figure as a valid axis', () => {
  const eur = moneyFigure([{ currency: 'EUR', revenueMinor: 180965, costMinor: 86640 }]);
  expect(sumMoneyFigures([eur, moneyFigure([], 'EUR')])).toEqual(eur);
  expect(sumMoneyFigures([eur, moneyFigure([], 'USD')]).currency).toBeNull();
  expect(moneyCurrency([eur, { currency: null, revenue: null, cost: null, net: null }])).toBeNull();
});
