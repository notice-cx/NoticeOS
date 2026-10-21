import type { SettingsPayload, SettingsPreferences } from "@shared/settings";
import { useSettings } from "./useSettings";

/** `config/constants.json`'s `operator_rate_usd_per_min` when no settings
 * have been read yet: the product default, so a score drawn before the
 * payload lands is the one the default installation would draw. */
export const FALLBACK_OPERATOR_RATE_USD_PER_MIN = 2;

/** The configured price of operator time, accepting either settings shape. */
export function operatorRateOf(settings: SettingsPayload | SettingsPreferences | null | undefined): number {
  if (settings && "operatorRateUsdPerMin" in settings) return validRate(settings.operatorRateUsdPerMin);
  const rate = settings?.budget?.knobs.find((knob) => knob.key === "operator_rate_usd_per_min")?.value;
  return validRate(rate);
}

function validRate(rate: unknown): number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_OPERATOR_RATE_USD_PER_MIN;
}

/** The rate as the settings read holds it now; the fallback until it has answered. */
export function useOperatorRate(): number {
  const { data } = useSettings('preferences');
  return operatorRateOf(data);
}
