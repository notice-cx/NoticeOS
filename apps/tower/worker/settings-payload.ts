// GET /api/settings — every portfolio-wide knob in one payload. A pure
// builder over resolved store-first configuration; it reads nothing itself.
// The budget caps and the anomaly-rule defaults come from `buildPortfolio` /
// `buildRules` in portfolio-settings.ts, the same knobs the asset page
// renders. What is editable here is exactly what the write lane allows: the
// knob values are resolved by pointer from the same declaration the lane
// licenses, and the catalog rows are passed verbatim rather than through
// `buildCatalog`, because a save's `expect` guard must be what the file holds.

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
  /** config/constants.json `os_time_zone` — the operator's clock. */
  osTimeZone: string;
  /** Whether somebody chose that clock (`timeZoneChosen`). Read by the route
   * from the config change record; absent means unknown, which proposes
   * nothing. */
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
  /** config/entities.json `/entities`, verbatim and in file order: the page
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
      // Untouched, like the catalog: every edit guards on the value it was rendered from.
      rows: deps.entities,
    },
    taskHub: {
      owner: BEADS_OWNER,
      spokes: deps.beads.spokes,
      // Absent in a build with no filesystem, where the map is read-only.
      hub: deps.beads.hub ?? null,
    },
  };
}

function buildCollection(deps: SettingsDeps): CollectionSettings {
  const pullAssets: PullEndpointSetting[] = deps.pullConfig.map((entry) => ({
    asset: entry.asset,
    url: entry.url,
    // A missing `enabled` is a lane that runs: the field is the off switch.
    enabled: entry.enabled !== false,
  }));
  return {
    knobs: knobValues({
      "config/signal-panels.json": deps.signalPanels,
    }),
    pullAssets,
    pullOwner: PULL_OWNER,
    // Verbatim: a schedule save is guarded by exactly this object.
    schedules: deps.schedules ?? null,
  };
}

/**
 * Every declared knob whose value this deployment can read, resolved by the
 * pointer the declaration names. A knob whose file is not injected, or whose
 * block a fresh install has not got, is simply absent, and renders as no row.
 * The docs come in as `unknown`: the pointer walk is the check.
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

/** The catalog rows, verbatim: a save guards on the value the row was
 * rendered from. Lane state is deliberately not carried; it is observed
 * evidence and belongs to `/health`. */
function buildSources(integrations: IntegrationsConfig): SourceSetting[] {
  // The three enums are optional on the config row's type and required here:
  // the register declares all three required and a payload test holds the
  // committed file to it. A row that broke that would render blank cells.
  return (integrations.catalog ?? []) as SourceSetting[];
}
