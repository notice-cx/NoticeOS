// The portfolio-wide settings rows out of config/constants.json: the anomaly
// rule defaults (`flag_defaults`), the monthly data cap and the operator's time
// rate. Pure builders over injected config, shared by the asset page and
// `/settings` so a knob has one name and one owning file.

import { FLAG_DEFAULT_META } from "../shared/tune";
import type {
  KnobFact,
  PortfolioConfig,
  PortfolioKnob,
  RulesInForce,
} from "../shared/asset-detail";
import { OWNER } from "../shared/asset-detail";

/** From `shared/tune.ts`, because a tune's stored note names the field it
 * changed and the field must read the same on `/settings` and in history. */
const KNOB_META = FLAG_DEFAULT_META;

/** The portfolio anomaly-rule defaults, as editable rows. */
export function buildRules(flagDefaults: Record<string, number | string>): RulesInForce {
  const knobs: KnobFact[] = Object.entries(flagDefaults).map(([key, value]) => {
    const meta = KNOB_META[key];
    return {
      key,
      label: meta?.label ?? key,
      jargon: meta?.jargon ?? key,
      value: String(value),
      explain: meta?.explain ?? "",
      owner: OWNER.constants,
      pointer: `/flag_defaults/${key}`,
      raw: value,
    };
  });
  return {
    scope: "portfolio-default",
    hasOverride: false,
    knobs,
  };
}

/** The portfolio spend cap and operator rate, as editable rows. */
export function buildPortfolio(
  monthlyCaps: { dataUsd: number },
  operatorRateUsdPerMin: number,
): PortfolioConfig {
  const knobs: PortfolioKnob[] = [
    {
      key: "monthly_caps.data_usd",
      pointer: "/monthly_caps/data_usd",
      label: "Monthly data cap",
      jargon: "monthly_caps.data_usd",
      value: monthlyCaps.dataUsd,
      unit: "usd",
    },
    {
      key: "operator_rate_usd_per_min",
      pointer: "/operator_rate_usd_per_min",
      label: "Value of your time",
      jargon: "operator_rate_usd_per_min",
      value: operatorRateUsdPerMin,
      unit: "usd_per_min",
    },
  ];
  return {
    owner: OWNER.constants,
    note: "Set once in Settings — not specific to this site.",
    knobs,
  };
}
