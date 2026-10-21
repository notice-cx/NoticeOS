import { describe, expect, it } from "vitest";
import type { SettingsPayload } from "@shared/settings";
import { FALLBACK_OPERATOR_RATE_USD_PER_MIN, operatorRateOf } from "@/hooks/useOperatorRate";

function settingsWith(value: unknown): SettingsPayload {
  return { budget: { owner: "config/constants.json", knobs: [
    { key: "monthly_caps.data_usd", pointer: "/monthly_caps/data_usd", label: "Data", jargon: "monthly_caps", value: 120, unit: "usd" },
    { key: "operator_rate_usd_per_min", pointer: "/operator_rate_usd_per_min", label: "Value of your time", jargon: "operator_rate_usd_per_min", value: value as number, unit: "usd_per_min" },
  ] } } as unknown as SettingsPayload;
}

describe("the operator rate every score divides by", () => {
  it("is the Value of your time knob when the settings carry one", () => {
    expect(operatorRateOf(settingsWith(3.5))).toBe(3.5);
  });

  it("falls back to the product default before the settings answer, or when the knob is not a price", () => {
    expect(operatorRateOf(undefined)).toBe(FALLBACK_OPERATOR_RATE_USD_PER_MIN);
    expect(operatorRateOf(null)).toBe(FALLBACK_OPERATOR_RATE_USD_PER_MIN);
    expect(operatorRateOf(settingsWith(0))).toBe(FALLBACK_OPERATOR_RATE_USD_PER_MIN);
    expect(operatorRateOf(settingsWith("2"))).toBe(FALLBACK_OPERATOR_RATE_USD_PER_MIN);
    expect(operatorRateOf(settingsWith(Number.NaN))).toBe(FALLBACK_OPERATOR_RATE_USD_PER_MIN);
  });
});
