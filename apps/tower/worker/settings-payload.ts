// GET /api/settings — every portfolio-wide knob in one payload.
//
// A PURE builder over resolved store-first configuration and clock-selection
// evidence supplied by the route. It reads nothing itself; compiled defaults
// keep settings visible when a document is absent or unavailable.
// The deps are parameters, so the test supplies its own fixture config exactly
// like the wall and asset-detail builders.
//
// IT REUSES RATHER THAN RESTATES. The budget caps and the anomaly-rule defaults
// come from `buildPortfolio` / `buildRules` in portfolio-settings.ts — the
// same knobs the asset page has rendered since 2026-07-06, which were never
// about one asset (bead `ro-pbzu.2` moves them here). A second builder for either
// would be a second answer to "what is this knob called and which file owns it".
// The source catalog is the one thing that stopped going through a builder at
// all — see the `expect` guard below.
//
// WHAT IS EDITABLE HERE IS EXACTLY WHAT THE WRITE LANE ALLOWS (D18) — and on
// 2026-09-05 that grew three times. The budget and the alert rules live in
// `config/constants.json`, wholesale-editable. The task-hub project map (bead
// `ro-x5gu.5`) and the data-source catalog (`ro-x5gu.6`) are declared
// REGISTERS, each licensing adds, removes and field edits at its own container
// and nothing else in its file. The collection cadence is a set of declared
// KNOBS (`ro-x5gu.8`), one exact pointer each, in two files that are otherwise
// still unreachable. The hub CONNECTION in `config/beads.json` is none of
// these: its port lives in three files that must agree, so it is rendered as the
// fixed fact it is.
//
// TWO CONSEQUENCES FOR THIS BUILDER, and both are about the `expect` guard a
// save carries. The knob values are resolved BY POINTER out of the injected
// config, from the same declaration the lane licenses, so the browser cannot
// send a pointer the lane does not know. And the catalog rows are passed
// VERBATIM rather than through `buildCatalog`: that builder fills a missing
// `scope` or `credential` in for the Health matrix, which is right there and
// wrong here — a guard the file never agreed with is a save refused as stale for
// a reason nobody can see.

import type { PullConfigEntry } from "./asset-config";
import { buildPortfolio, buildRules } from "./portfolio-settings";
import { OWNER } from "../shared/asset-detail";
import { resolvePointer, type JsonValue } from "../shared/changeset";
import { knobEntries } from "../shared/config-registers";
import { ENTITIES_OWNER, type EntityRow } from "../shared/entities";
import type { DashboardConfig } from "../shared/dashboard";
import type { ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";
import { INTEGRATIONS_OWNER, type IntegrationsConfig } from "../shared/integrations";
import type {
  BeadsConfig,
  CollectionSettings,
  KnobValueSetting,
  PullEndpointSetting,
  SettingsPayload,
  SourceSetting,
} from "../shared/settings";

/** Where the pull registry lives (the same file the asset page's wiring edits). */
export const PULL_OWNER = "config/pull.json";
/** Where the task hub's spoke map lives. */
export const BEADS_OWNER = "config/beads.json";

export interface SettingsDeps {
  now: Date;
  /** config/constants.json `os_time_zone` — the operator's clock (bead ro-py40). */
  osTimeZone: string;
  /** Whether somebody chose that clock (`timeZoneChosen`, bead
   * `ro-ujb9.134`). Read by the route from the config change record; absent
   * means unknown, which proposes nothing. */
  timeZoneChosen?: boolean;
  /** config/constants.json `monthly_caps`. */
  monthlyCaps: { dataUsd: number };
  /** config/constants.json `operator_rate_usd_per_min`. */
  operatorRateUsdPerMin: number;
  /** config/constants.json `flag_defaults`, verbatim (snake_case keys). */
  flagDefaults: Record<string, number | string>;
  /** config/signal-panels.json — read here only for the `/refresh` block, whose
   * two declared knobs are the collection cadence a file still holds. The
   * roster it sits beside belongs to the asset pages. */
  signalPanels: { refresh?: Record<string, unknown> };
  /** config/pull.json, verbatim. */
  pullConfig: PullConfigEntry[];
  /** config/integrations.json, verbatim — the catalog half only. */
  integrations: IntegrationsConfig;
  /** config/entities.json `/entities`, verbatim and in FILE ORDER: the page
   * edits these rows, and a collection editor addresses one by its index. */
  entities: EntityRow[];
  /** config/tower.json, parsed — the shared TV display config. */
  dashboard: DashboardConfig;
  /** config/beads.json — the project map, plus the hub connection on a build
   * that has a filesystem (`shared/settings.ts` says why it crosses at all). */
  beads: BeadsConfig;
  /** config/constants.json `/schedules`, verbatim — null while none has been
   * saved. Optional so a caller with no schedules to state need not say so. */
  schedules?: ScheduleOverrides | null;
}

export function buildSettingsPayload(deps: SettingsDeps): SettingsPayload {
  const portfolio = buildPortfolio(deps.monthlyCaps, deps.operatorRateUsdPerMin);
  const rules = buildRules(deps.flagDefaults);

  return {
    generatedAt: deps.now.toISOString(),
    // No `note` on any section (bead `ro-ujb9.96.6.3`): a sentence shipped
    // here is a sentence the page renders word for word. What a section's
    // setting decides is shown by the page as state — the zone's live values,
    // the cap's meter, an "All assets" scope chip.
    clock: {
      owner: OWNER.constants,
      timeZone: deps.osTimeZone,
      chosen: deps.timeZoneChosen ?? true,
    },
    dashboard: deps.dashboard,
    budget: {
      owner: portfolio.owner,
      knobs: portfolio.knobs,
    },
    alertRules: {
      owner: rules.knobs[0]?.owner ?? "config/constants.json",
      knobs: rules.knobs,
    },
    collection: buildCollection(deps),
    sources: {
      owner: INTEGRATIONS_OWNER,
      rows: buildSources(deps.integrations),
    },
    entities: {
      owner: ENTITIES_OWNER,
      // No builder: the rows go through untouched for the same reason the
      // catalog does — this page edits them, and every edit guards on the value
      // it was rendered from.
      rows: deps.entities,
    },
    taskHub: {
      owner: BEADS_OWNER,
      spokes: deps.beads.spokes,
      // Absent in a build with no filesystem — and that is also the build where
      // the map is read-only, so nothing downstream has to guard it twice.
      hub: deps.beads.hub ?? null,
    },
  };
}

function buildCollection(deps: SettingsDeps): CollectionSettings {
  const pullAssets: PullEndpointSetting[] = deps.pullConfig.map((entry) => ({
    asset: entry.asset,
    url: entry.url,
    // A missing `enabled` is a lane that runs: the field is the OFF switch, and
    // reading its absence as "paused" would report an asset dark that is not.
    enabled: entry.enabled !== false,
  }));
  return {
    knobs: knobValues({
      "config/signal-panels.json": deps.signalPanels,
    }),
    pullAssets,
    pullOwner: PULL_OWNER,
    // Verbatim, like the catalog rows: a schedule save is guarded by exactly
    // this object, so a defaulted or reordered copy would be refused as stale.
    schedules: deps.schedules ?? null,
  };
}

/**
 * Every declared knob whose value this deployment can actually read, resolved
 * by the pointer the declaration names (bead `ro-x5gu.8`).
 *
 * The map is keyed by the knob's own `file`, so a knob added to the declaration
 * appears here the moment its file is injected and NOTHING in this builder is
 * touched — and one whose file is not injected, or whose block a fresh install
 * has not got, is simply absent. Absent is a real state and renders as no row;
 * a zero here would claim somebody had configured a cadence of nothing.
 *
 * The docs come in as `unknown` on purpose: the pointer walk IS the check, and
 * a shape this builder asserted instead would be a second opinion about a file
 * it does not own.
 */
function knobValues(docs: Record<string, unknown>): KnobValueSetting[] {
  const found: KnobValueSetting[] = [];
  for (const [key, knob] of knobEntries()) {
    const doc = docs[knob.file];
    if (doc === undefined) continue;
    const value = resolvePointer(doc as JsonValue, knob.pointer);
    if (value === undefined) continue;
    found.push({ key, value });
  }
  return found;
}

/**
 * The catalog rows, VERBATIM (bead `ro-x5gu.6`).
 *
 * They used to come through `buildCatalog`, reduced to five fields with defaults
 * filled in for the missing ones. Both halves of that are wrong now that
 * `/settings` EDITS these rows: a save guards on the value the row was rendered
 * from, so a defaulted `scope` would send a guard the file never held, and the
 * four prose fields the reduction dropped are columns the operator edits.
 *
 * Lane STATE is still deliberately not carried: it is observed evidence, it
 * belongs to `/health`, and a state word here that came from a file rather than
 * a collector run would be exactly the declaration doc 11 warns about.
 */
function buildSources(integrations: IntegrationsConfig): SourceSetting[] {
  // The three enums are OPTIONAL on the config row's type and required here,
  // and that is not a defaulting in disguise: the register declares all three
  // required, config/integrations.README.md's validation refuses a catalog row
  // missing one, and an integrations payload test holds the committed file to
  // it. A row that broke that would render blank cells the operator can fill in
  // — which is the honest outcome, and better than a value nobody chose.
  return (integrations.catalog ?? []) as SourceSetting[];
}
