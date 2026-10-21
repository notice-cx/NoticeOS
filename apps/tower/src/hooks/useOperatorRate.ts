import type { SettingsPayload } from "@shared/settings";
import { useSettings } from "./useSettings";

/** `config/constants.json`'s `operator_rate_usd_per_min` when no settings
 * have been read yet: the product default, so a score drawn before the
 * payload lands is the one the default installation would draw. */
export const FALLBACK_OPERATOR_RATE_USD_PER_MIN = 2;

/**
 * Settings' "Value of your time", USD a minute, the one price every score
 * divides by. It is a budget knob in the settings payload, not a field of its
 * own, so every reader comes through here rather than each finding the knob.
 */
export function operatorRateOf(settings: SettingsPayload | null | undefined): number {
  const rate = settings?.budget?.knobs.find((knob) => knob.key === "operator_rate_usd_per_min")?.value;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_OPERATOR_RATE_USD_PER_MIN;
}

/** The rate as the settings read holds it now; the fallback until it has answered. */
export function useOperatorRate(): number {
  const { data } = useSettings();
  return operatorRateOf(data);
}
