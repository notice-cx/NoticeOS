// Where the Tower's settings come from, per request. Store first, bundle
// second, always an answer: every value resolves from the stored document
// when there is one and from the compiled copy (`vite.config.ts` `define`)
// when there is not, and `sources` says which answered, per file. A stored
// document is untrusted shape, so every reader below is total and answers the
// compiled copy the moment the shape is not what it needs. The ingest reads
// every document in one RPC, resolved once per request (`towerConfigResolver`).

import type {
  Ga4EventParamsConfig,
  PullConfigEntry,
  SerpPanelConfig,
  SignalPanelsConfig,
  ValueEventsConfig,
} from "./asset-config";
import type { CountersConfig } from "./counters";
import type { WorkspaceStore } from "@noticeos/postgres";
import { configDocumentKey } from "../../../scripts/config-documents.mjs";
import type { EntityRow } from "../shared/entities";
import type { DomainOrder, RecurringCost } from "../shared/financials";
import type { IntegrationsConfig } from "../shared/integrations";
import { logicalTaskProjects, type BeadsConfig } from "../shared/settings";
import { type DashboardConfig, readDashboardConfig } from "../shared/dashboard";
import { savedOsTimeZone } from "@noticeos/contract/time-zone-setting";
import { noNightlyReportAssets } from "@noticeos/contract/configuration";
import { TOWER_CONFIG_FILES } from "@noticeos/contract/configuration";
import type { ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";

import type { ConfigDocumentRead, ApplyConfigOpsInput, ApplyConfigOpsResult } from '@noticeos/contract/configuration';
export type { ConfigDocumentRead } from '@noticeos/contract/configuration';
export type ConfigOpsResult = ApplyConfigOpsResult;

/** The structural binding accepts untrusted operations; ingest validates them. */
export interface ConfigDocumentReader {
  getConfigDocuments(files: string[], originalProof?: Request): Promise<ConfigDocumentRead[]>;
  applyConfigOps(input: ApplyConfigOpsInput<unknown>, originalProof?: Request): Promise<ConfigOpsResult>;
}

/** Every config file the Tower reads, and the repo path that names it. One
 * place, so a file the resolver forgets to ask for cannot silently stay on the
 * bundle. */
export { TOWER_CONFIG_FILES };

export type TowerConfigKey = keyof typeof TOWER_CONFIG_FILES;

/** The compiled copies — what `vite.config.ts` injected, passed in rather than
 * read here so this module never touches a `define`. */
export interface TowerConfigFallbacks {
  monthlyCaps: { dataUsd: number };
  flagDefaults: Record<string, number | string>;
  operatorRateUsdPerMin: number;
  osTimeZone: string;
  /** The assets declared as sending no nightly report (config/constants.json
   * `no_nightly_report`); null or absent when none has ever been declared. */
  noNightlyReport?: string[] | null;
  /** The saved job schedules (config/constants.json `schedules`), verbatim;
   * null or absent when none has been saved. */
  schedules?: ScheduleOverrides | null;
  pullConfig: PullConfigEntry[];
  integrations: IntegrationsConfig;
  counters: CountersConfig;
  dashboard: DashboardConfig;
  serpPanel: SerpPanelConfig;
  signalPanels: SignalPanelsConfig;
  valueEvents: ValueEventsConfig;
  ga4EventParams: Ga4EventParamsConfig;
  domainOrders: DomainOrder[];
  recurringCosts: RecurringCost[];
  entities: EntityRow[];
  beads: BeadsConfig;
}

export interface TowerConfig extends TowerConfigFallbacks {
  /** Always answered once resolved: the saved list, or null for none. */
  noNightlyReport: string[] | null;
  /** Always answered once resolved: the saved schedules, or null for none. */
  schedules: ScheduleOverrides | null;
  /** Where each file's value came from on this request, by repo path. */
  sources: Record<string, "store" | "file">;
  /** The store's version per file, for a writer's `expectVersion`. */
  versions: Record<string, number | null>;
  storeAvailable: boolean;
  storeFailure: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A named container out of a document, or null when the shape is not there. */
function container(doc: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(doc)) return null;
  const held = doc[key];
  return isObject(held) ? held : null;
}

function list(doc: unknown, key: string): unknown[] | null {
  if (!isObject(doc)) return null;
  const held = doc[key];
  return Array.isArray(held) ? held : null;
}

/**
 * Resolve every setting the Tower reads, once.
 *
 * `ingest` absent (a test double that declares no config RPC, an env without the
 * binding) answers the compiled copies with every source marked `file`, which is
 * the same answer an unseeded store gives — the page renders either way.
 */
export async function resolveTowerConfig(
  ingest: Pick<ConfigDocumentReader, "getConfigDocuments"> | null | undefined,
  fallbacks: TowerConfigFallbacks,
): Promise<TowerConfig> {
  const files = Object.values(TOWER_CONFIG_FILES);
  const sources: Record<string, "store" | "file"> = {};
  const versions: Record<string, number | null> = {};
  for (const file of files) {
    sources[file] = "file";
    versions[file] = null;
  }

  let reads: ConfigDocumentRead[] = [];
  let storeAvailable = false;
  let storeFailure: string | null = "Configuration is unavailable. Showing built-in settings.";
  if (ingest && typeof ingest.getConfigDocuments === "function") {
    try {
      reads = await ingest.getConfigDocuments([...files]);
      storeAvailable = true;
      storeFailure = null;
    } catch {
      // The ingest not answering is its own visible condition; the page renders.
      reads = [];
    }
  }

  const stored = new Map<string, unknown>();
  for (const read of reads) {
    if (read.source !== "store") continue;
    stored.set(read.file, read.body);
    sources[read.file] = "store";
    versions[read.file] = read.version;
  }

  const constants = stored.get(TOWER_CONFIG_FILES.constants);
  const caps = container(constants, "monthly_caps");
  // An unknown key (an older document's `inference_usd`) is ignored, never a
  // reason to fall back.
  const monthlyCaps =
    caps !== null && typeof caps.data_usd === "number"
      ? { dataUsd: caps.data_usd }
      : fallbacks.monthlyCaps;
  // Per key, like the ingest's own detector (`ruleConfigFromConstants`): a
  // saved rule set that lacks a key shows and runs on the compiled one, and
  // its Save creates the key.
  const storedFlagDefaults = container(constants, "flag_defaults") as Record<string, number | string> | null;
  const flagDefaults = { ...fallbacks.flagDefaults, ...storedFlagDefaults };
  const rate = isObject(constants) ? constants.operator_rate_usd_per_min : undefined;
  const operatorRateUsdPerMin =
    typeof rate === "number" ? rate : fallbacks.operatorRateUsdPerMin;
  // The operator's clock, through the one store-first read the ingest shares.
  // A stored zone `Intl` cannot resolve falls back to the compiled copy rather
  // than quietly moving every boundary to UTC.
  const osTimeZone = savedOsTimeZone(constants, fallbacks.osTimeZone);
  // A saved constants document answers for itself, key absent included; only
  // an unseeded store falls back to the compiled copy. The ingest's own rule.
  const noNightlyReport =
    constants === undefined ? (fallbacks.noNightlyReport ?? null) : noNightlyReportAssets(constants);
  // The same rule for the saved schedules, passed through verbatim because a
  // schedule save is guarded by exactly this object; what each entry may hold
  // is the write door's `schedulesRefusal`.
  const schedules =
    constants === undefined
      ? (fallbacks.schedules ?? null)
      : (container(constants, "schedules") as ScheduleOverrides | null);

  const pullDoc = stored.get(TOWER_CONFIG_FILES.pull);
  const pullConfig = Array.isArray(pullDoc)
    ? (pullDoc as PullConfigEntry[])
    : fallbacks.pullConfig;

  const integrationsDoc = stored.get(TOWER_CONFIG_FILES.integrations);
  const integrationsAssets = container(integrationsDoc, "assets");
  const integrationsCatalog = list(integrationsDoc, "catalog");
  const integrations =
    integrationsAssets !== null && integrationsCatalog !== null
      ? ({ catalog: integrationsCatalog, assets: integrationsAssets } as unknown as IntegrationsConfig)
      : fallbacks.integrations;

  const countersDoc = stored.get(TOWER_CONFIG_FILES.counters);
  const counterAssets = container(countersDoc, "assets");
  // How often the cards are read is the counters job's schedule, not this document.
  const counters =
    counterAssets !== null
      ? ({ assets: counterAssets } as unknown as CountersConfig)
      : fallbacks.counters;

  // Read part by part: a saved part the Tower cannot read is left out and
  // named in `dashboard.refused`, with the value as stored. Only a document
  // that is not an object at all falls back to the compiled copy.
  const dashboardDoc = stored.get(TOWER_CONFIG_FILES.dashboard);
  let dashboard = fallbacks.dashboard;
  if (dashboardDoc !== undefined) {
    try {
      dashboard = readDashboardConfig(dashboardDoc);
    } catch {
      dashboard = fallbacks.dashboard;
    }
  }

  const serpAssets = container(stored.get(TOWER_CONFIG_FILES.serpPanel), "assets");
  const serpPanel =
    serpAssets === null
      ? fallbacks.serpPanel
      : ({ assets: serpAssets } as unknown as SerpPanelConfig);

  const panelsDoc = stored.get(TOWER_CONFIG_FILES.signalPanels);
  const panelAssets = container(panelsDoc, "assets");
  const signalPanels =
    panelAssets === null
      ? fallbacks.signalPanels
      : ({
          assets: panelAssets,
          refresh: container(panelsDoc, "refresh") ?? {},
        } as unknown as SignalPanelsConfig);

  const valueAssets = container(stored.get(TOWER_CONFIG_FILES.valueEvents), "assets");
  const valueEvents =
    valueAssets === null
      ? fallbacks.valueEvents
      : ({ assets: valueAssets } as unknown as ValueEventsConfig);

  const ga4Assets = container(stored.get(TOWER_CONFIG_FILES.ga4EventParams), "assets");
  const ga4EventParams =
    ga4Assets === null
      ? fallbacks.ga4EventParams
      : ({ assets: ga4Assets } as unknown as Ga4EventParamsConfig);

  const domains = list(stored.get(TOWER_CONFIG_FILES.domainCosts), "domains");
  const domainOrders = domains === null ? fallbacks.domainOrders : (domains as DomainOrder[]);

  const costs = list(stored.get(TOWER_CONFIG_FILES.recurringCosts), "costs");
  const recurringCosts = costs === null ? fallbacks.recurringCosts : (costs as RecurringCost[]);

  // An empty list is a real answer; the fallback is taken only when the
  // container is not a list at all.
  const declared = list(stored.get(TOWER_CONFIG_FILES.entities), "entities");
  const entities = declared === null ? fallbacks.entities : (declared as EntityRow[]);

  // The hub connection is not carried forward from the store: it is this
  // machine's internal topology, stripped from a build by `vite.config.ts`,
  // so the projects may come from the store and the connection is always the
  // compiled answer. The key is reached through a type rather than a string
  // literal because `scripts/ui-lexicon.test.mjs` reads quoted words in
  // shipped Worker code as operator copy.
  const beadsDoc = stored.get(TOWER_CONFIG_FILES.beads);
  const storedSpokes = isObject(beadsDoc)
    ? (beadsDoc as { spokes?: unknown }).spokes
    : undefined;
  const selectedSpokes = Array.isArray(storedSpokes) ? storedSpokes : fallbacks.beads.spokes;
  const beads = {
    spokes: fallbacks.beads.hub == null ? logicalTaskProjects(selectedSpokes) : selectedSpokes,
    hub: fallbacks.beads.hub ?? null,
  } as BeadsConfig;

  return {
    monthlyCaps,
    flagDefaults,
    operatorRateUsdPerMin,
    osTimeZone,
    noNightlyReport,
    schedules,
    pullConfig,
    integrations,
    counters,
    dashboard,
    serpPanel,
    signalPanels,
    valueEvents,
    ga4EventParams,
    domainOrders,
    recurringCosts,
    entities,
    beads,
    sources,
    versions,
    storeAvailable,
    storeFailure,
  };
}

/** One resolver per request, so routes reading the same documents share one read. */
export function towerConfigResolver(
  ingest: Pick<ConfigDocumentReader, "getConfigDocuments"> | null | undefined,
  fallbacks: TowerConfigFallbacks,
): () => Promise<TowerConfig> {
  let pending: Promise<TowerConfig> | null = null;
  return () => {
    pending ??= resolveTowerConfig(ingest, fallbacks);
    return pending;
  };
}

/**
 * Has a save ever set the clock? The config change record (`config_changes`)
 * holds every applied op, so a Settings save of the zone — or its Undo — is a
 * row of the `constants` document whose ops name `/os_time_zone`. A seed is a
 * `document-seed` op with no pointer, so it does not count. A store that
 * cannot answer is "unknown", which the caller treats as chosen.
 */
export async function timeZoneEverSaved(store: WorkspaceStore): Promise<boolean | null> {
  const key = configDocumentKey(TOWER_CONFIG_FILES.constants);
  try {
    const [row] = await store.read((tx) =>
      tx.query<{ saved: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM noticeos.config_changes
            WHERE document_key = $1 AND ops @> '[{"pointer": "/os_time_zone"}]'
         ) AS saved`,
        [key],
      ),
    );
    return row === undefined ? null : row.saved;
  } catch {
    return null;
  }
}
