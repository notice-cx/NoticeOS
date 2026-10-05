// Where the Tower's settings come from, per request (epic `ro-syok`, db/0029).
//
// UNTIL NOW THEY CAME FROM THE BUNDLE. `apps/tower/vite.config.ts` reads twelve
// config files at build time and injects them with `define`, which is why a
// deployed Tower could render a setting and never save one: config is
// version-controlled files (docs/06) and a Worker has no filesystem. The store
// now holds each of those files as a whole JSON document, and this module is
// what asks for them.
//
// STORE FIRST, BUNDLE SECOND, ALWAYS AN ANSWER. Every value below resolves from
// the stored document when there is one and from the compiled copy when there is
// not — so an install that has applied the migration and never seeded behaves
// exactly as it did before, and one whose store is unreachable renders the page
// instead of an error. `sources` says which of the two answered, per file, so
// the Settings page can tell the operator where a value came from rather than
// leaving them to guess which OS they are looking at.
//
// A STORED DOCUMENT IS UNTRUSTED SHAPE. It was written through the validating
// pipeline, but it is a row rather than a compiled constant, and a page that
// went blank because one document lost a key would be a worse failure than a
// stale value. So every reader below is total: it takes the document, and
// answers the compiled copy the moment the shape is not what it needs.
//
// ONE ROUND TRIP. The ingest reads all twelve in one RPC, and this resolves them
// once per request — see `towerConfig` at the bottom, which memoizes for the
// life of a request so eleven routes reading the same document do not become
// eleven reads.

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
   * `no_nightly_report`, bead `ro-ujb9.96.8`); null or absent when none has
   * ever been declared — the key is absent, so the first declaration creates
   * it. Optional so a caller with nothing to declare need not say so. */
  noNightlyReport?: string[] | null;
  /** The saved job schedules (config/constants.json `schedules`, bead
   * `ro-ujb9.96.7.12`), verbatim; null or absent when none has been saved.
   * Optional for the same reason as `noNightlyReport`. */
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
      // The ingest not answering is its own visible condition; a settings page
      // that went blank over it would be a worse failure than a stale value.
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
  // A document seeded before 2026-09-05 still carries `inference_usd` beside
  // `data_usd` (D6, bead `ro-uj7x`). Reading only what is read keeps that store
  // copy usable — an unknown key is ignored, never a reason to fall back.
  const monthlyCaps =
    caps !== null && typeof caps.data_usd === "number"
      ? { dataUsd: caps.data_usd }
      : fallbacks.monthlyCaps;
  // Per key, like the cap and the rate beside it and like the ingest's own
  // detector (`ruleConfigFromConstants`): a saved rule set that lacks a key
  // shows — and runs on — the compiled one, and its Save creates the key
  // (bead `ro-dk4u`).
  const storedFlagDefaults = container(constants, "flag_defaults") as Record<string, number | string> | null;
  const flagDefaults = { ...fallbacks.flagDefaults, ...storedFlagDefaults };
  const rate = isObject(constants) ? constants.operator_rate_usd_per_min : undefined;
  const operatorRateUsdPerMin =
    typeof rate === "number" ? rate : fallbacks.operatorRateUsdPerMin;
  // The operator's clock, through the one store-first read every day-boundary
  // reader shares (bead `ro-ujb9.88`) — the ingest resolves its zone with the
  // same function, so the two Workers cannot disagree about which day it is.
  // `vite.config.ts` validates the compiled zone at BUILD time; a stored one has
  // no build to fail, so a zone `Intl` cannot resolve falls back to the
  // compiled copy rather than quietly moving every boundary to UTC.
  const osTimeZone = savedOsTimeZone(constants, fallbacks.osTimeZone);
  // A SAVED constants document answers for itself, key absent included: absent
  // there means nobody has declared, not "ask the build". Only an unseeded
  // store falls back to the compiled copy — the ingest's own rule, so the two
  // Workers count the same assets as owing a report.
  const noNightlyReport =
    constants === undefined ? (fallbacks.noNightlyReport ?? null) : noNightlyReportAssets(constants);
  // The same rule for the saved schedules (bead `ro-ujb9.96.7.12`): a saved
  // constants document answers for itself, key absent included. Passed through
  // VERBATIM — a schedule save is guarded by exactly this object — and only its
  // container shape is checked; what each entry may hold is the write door's
  // `schedulesRefusal`, which every save runs.
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
  // How often the cards are read is the counters job's schedule, above — not
  // this document (bead ro-ujb9.222).
  const counters =
    counterAssets !== null
      ? ({ assets: counterAssets } as unknown as CountersConfig)
      : fallbacks.counters;

  // Read part by part (bead `ro-trai.45`): a saved part the Tower cannot read
  // is left out and NAMED in `dashboard.refused`, with the value as stored, so
  // the TV draws the default in its place and the editor says so and guards on
  // what the store holds. Only a document that is not an object at all falls
  // back to the compiled copy.
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

  // An EMPTY list is a real answer here and the compiled copy's own value: no
  // entity is declared until somebody declares one. So the fallback is taken
  // only when the container is not a list at all, never when it is short.
  const declared = list(stored.get(TOWER_CONFIG_FILES.entities), "entities");
  const entities = declared === null ? fallbacks.entities : (declared as EntityRow[]);

  // THE HUB CONNECTION IS NOT CARRIED FORWARD FROM THE STORE. `vite.config.ts`
  // strips `/hub` from a BUILD because it is this machine's internal topology,
  // and a stored document must not be the way it gets out. So the spokes may
  // come from the store and the connection is always the compiled answer, which
  // is `null` in a deployed bundle by construction.
  //
  // The key is reached through a type rather than a string literal because
  // `scripts/ui-lexicon.test.mjs` reads quoted words in shipped Worker code as
  // operator copy, and this one is a JSON key in a config file (doc 17 rule 8).
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

/**
 * One resolver per request. Eleven routes read the same documents; without this
 * a page load would be eleven RPC hops and eleven store reads for a set of rows
 * an operator changes a few times a week.
 */
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
 * HAS A SAVE EVER SET THE CLOCK? (bead `ro-ujb9.134`) The config change record
 * (`config_changes`, on Postgres since bead ro-ujb9.76.4.1) holds every
 * applied op, so a Settings save of the zone — or its Undo, which is a
 * decision too — is a row of the `constants` document whose ops name
 * `/os_time_zone`. A seed is recorded as a `document-seed` op with no pointer,
 * so a new installation's first seed does not count.
 *
 * Total like every reader here: a store that cannot answer is "unknown", which
 * the caller treats as chosen, so a first run never proposes a clock on a
 * guess.
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
