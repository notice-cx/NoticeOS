// The settings contract — the payload `GET /api/settings` returns: the one
// page an operator opens when the question is "where do I configure this".
// The portfolio knobs and the anomaly rules are the exact shapes the asset
// page already renders (`PortfolioKnob`, `KnobFact`). Every section names its
// owner file; the editable ones save through the guarded configuration store.

import type { KnobFact, PortfolioKnob } from "./asset-detail";
import type { JsonValue } from "./changeset";
import type { ConfigKnobKey } from "./config-registers";
import type { EntityRow } from "./entities";
import type { DashboardConfig } from "./dashboard";
import type { CredentialScope, IntegrationLayer, LaneScope } from "./integrations";
import type { ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";

/** The clock the whole OS reads in (`config/constants.json` `os_time_zone`):
 * the zone every intraday chart is re-bucketed into. */
export interface ClockSettings {
  owner: string;
  /** An IANA zone name, validated at the build boundary. */
  timeZone: string;
  /** Somebody chose this clock (`timeZoneChosen`). While false, a first run
   * offers the browser's zone with one press. */
  chosen: boolean;
}

/** Portfolio spend caps + the operator's own rate (`config/constants.json`). */
export interface BudgetSettings {
  owner: string;
  knobs: PortfolioKnob[];
}

/** The anomaly-rule defaults every asset inherits (`config/constants.json`). */
export interface AlertRuleSettings {
  owner: string;
  knobs: KnobFact[];
}

/** One `config/pull.json` entry, as the settings page reads it: which asset the
 * OS scrapes, from where, and whether the lane is running. Read-only here — the
 * endpoint and its switch are edited on that asset's own page, where the rest of
 * its wiring is. */
export interface PullEndpointSetting {
  asset: string;
  url: string;
  enabled: boolean;
}

/** One declared knob's current value. The label and the rule are the
 * declaration in `scripts/config-registers.mjs`, which the browser reads
 * through `shared/config-registers.ts`. */
export interface KnobValueSetting {
  /** Which entry in `CONFIG_KNOBS` this is. */
  key: ConfigKnobKey;
  /** What the file holds right now — and therefore the save's `expect`. */
  value: JsonValue;
}

/** How often the OS reads, how far back it looks, and who it reads from. Each
 * knob names its own owner file through its declaration — the read interval
 * belongs to the counters lane and the panel window to the refresh roster — and
 * the endpoints belong to the pull registry, so one chip over the section would
 * point at the wrong file two times in three. */
export interface CollectionSettings {
  /** The declared knobs this deployment could read a value for, in declaration
   * order. A knob whose block a config does not carry is ABSENT rather than
   * rendered as a zero nobody configured. */
  knobs: KnobValueSetting[];
  pullAssets: PullEndpointSetting[];
  pullOwner: string;
  /** The saved job schedules (`config/constants.json` `/schedules`), verbatim,
   * or null while none has ever been saved: a schedule save is guarded by
   * exactly this object. What the runner actually armed stays System
   * health's. */
  schedules: ScheduleOverrides | null;
}

/**
 * One catalog lane, exactly as `config/integrations.json` `/catalog` holds it:
 * `/settings` edits these rows, and an edit's `expect` is the concurrency
 * guard, so a defaulted field would send a guard the file never agreed with.
 * State is deliberately absent — that is `/health`, read off evidence.
 */
export type SourceSetting = {
  id: string;
  label: string;
  scope: LaneScope;
  layer: IntegrationLayer;
  credential: CredentialScope;
  /** The doc section that explains it. */
  docRef?: string;
};

export interface SourcesSettings {
  owner: string;
  rows: SourceSetting[];
}

/**
 * The portfolio's legal entities and the assets each one owns, verbatim for
 * the reason the catalog above is. An entity that owns nothing carries no
 * `assets` key at all, and the difference between that and `[]` decides
 * whether its first asset is a first write or an ordinary one.
 */
export interface EntitiesSettings {
  owner: string;
  rows: EntityRow[];
}

/** One saved task project (`config/beads.json`): the asset and its task id
 * prefix (`ex` in `ex-1w2`), which names its Ntasks project, and the database
 * name each row keeps from before tasks moved to Ntasks. */
export interface TaskHubSpoke {
  asset: string;
  prefix: string;
  database: string;
  /** Legacy local editor metadata. Never carried into deployed settings. */
  repo?: string;
}

/** The deployed presentation contains workspace project identity only. */
export function logicalTaskProjects(rows: unknown[]): TaskHubSpoke[] {
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { asset, prefix, database } = row as Partial<TaskHubSpoke>;
    return typeof asset === "string" && typeof prefix === "string" && typeof database === "string"
      ? [{ asset, prefix, database }] : [];
  });
}

export interface TaskHubSettings {
  owner: string;
  spokes: TaskHubSpoke[];
  /** True while `vite` serves this Tower on its own machine, where the
   * project map is edited; false in a deployed build, where it is read-only. */
  local: boolean;
}

/** `config/beads.json` as the Tower reads it: the project map, and whether
 * this Tower is served from its own machine (`vite.config.ts`). */
export interface TaskProjectsConfig {
  spokes: TaskHubSpoke[];
  local?: boolean;
}

/** GET /api/settings — every portfolio-wide knob, in the order the page renders
 * them. The pure builder receives resolved store-first configuration and the
 * route's clock-selection evidence; it performs no reads itself. */
/** Small settings read for score calculations and the Home clock proposal. */
export interface SettingsPreferences {
  clock: ClockSettings;
  operatorRateUsdPerMin: number;
}

export interface SettingsPayload {
  generatedAt: string;
  portfolioReview: { owner: string; assetIds: string[] | null; assets: { id: string; displayName: string }[] };
  /** The operator's clock (`config/constants.json`). */
  clock: ClockSettings;
  /** The shared TV display config (`config/tower.json`). Its `countdown` is
   * optional, and the page renders no TV section at all when it is absent. */
  dashboard: DashboardConfig;
  budget: BudgetSettings;
  alertRules: AlertRuleSettings;
  collection: CollectionSettings;
  sources: SourcesSettings;
  /** Who owns what (`config/entities.json`) — the list the asset page's
   * Identity picker chooses from. */
  entities: EntitiesSettings;
  taskHub: TaskHubSettings;
}
