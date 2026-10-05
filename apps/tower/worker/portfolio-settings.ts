// The portfolio-wide settings rows out of config/constants.json: the anomaly
// rule defaults (`flag_defaults`), the monthly data cap and the operator's time
// rate. Pure builders over injected config — no store read.
//
// None of them was ever about one asset. The asset page has rendered them since
// 2026-07-06 and `/settings` renders the same knobs since bead `ro-pbzu.2`, so
// they are built once, here, and each page builder composes them: a second
// builder would be a second answer to what a knob is called and which file
// owns it.

import { FLAG_DEFAULT_META } from "../shared/tune";
import type {
  KnobFact,
  PortfolioConfig,
  PortfolioKnob,
  RulesInForce,
} from "../shared/asset-detail";
import { OWNER } from "../shared/asset-detail";

/** Plain-language copy for each known flag_defaults knob (principle 9: label in
 * words, jargon in parens, a one-line explainer). Unknown keys fall back to raw. */
/** What each `flag_defaults` setting is called, from `shared/tune.ts` — the one
 * place, because a tune's stored note names the field it changed and a field
 * cannot be called one thing on `/settings` and another in an alert's history
 * (bead `ro-van6`). */
const KNOB_META = FLAG_DEFAULT_META;

/**
 * The portfolio anomaly-rule defaults, as editable rows.
 *
 * EXPORTED because `/settings` renders the same three knobs (bead `ro-pbzu.2`)
 * — they were never about one asset, and a second builder would be a second
 * answer to what `alpha` is called and which file owns it.
 */
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
  // No `note` (bead `ro-ujb9.96.6.3`): `scope` and `hasOverride` ARE the fact,
  // and a surface says it as state rather than rendering a sentence from here.
  return {
    scope: "portfolio-default",
    hasOverride: false,
    knobs,
  };
}

/** The portfolio spend caps + operator rate, as editable rows. Exported for the
 * same reason `buildRules` is: `/settings` is where these live now.
 *
 * NO EXPLAINER RIDES WITH A KNOB (bead `ro-ujb9.96.6.3`). Its unit and effect
 * are a label-length line the page owns beside the field, and its current state
 * is the visual beside that — the cap's meter of this month's spend, the rate's
 * hourly figure. A paragraph here was a paragraph in a tooltip there. */
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
    // NO INFERENCE CAP. It sat here until 2026-09-05 and was withdrawn with
    // D6 (bead `ro-uj7x`): nothing in the OS calls a model, so no meter could
    // ever be drawn beside it and the row could only state a ceiling and admit
    // it was not instrumented. The data cap above is the only one anything
    // enforces.
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
