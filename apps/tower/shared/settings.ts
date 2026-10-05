// Shared SETTINGS contract — the single payload `GET /api/settings` returns.
//
// Same discipline as wall.ts and asset-detail.ts: pure types, no runtime deps,
// safe in workerd and imported by the client. This is the contract behind the
// one page an operator (or a stranger) opens when the question is "where do I
// configure this" — until bead `ro-pbzu.2` the answer was six different files
// and two other pages (doc 19 finding 18).
//
// It DEFINES almost nothing of its own. The portfolio knobs and the anomaly
// rules are the exact shapes the asset page already renders (`PortfolioKnob`,
// `KnobFact`), because they are the same knobs — the settings page is where they
// belong, not a second spelling of them. What is new here is the document-backed
// config nothing rendered anywhere: the counters cadence, the pull registry, the
// source catalog and the task-hub spoke map.
//
// EVERY SECTION NAMES ITS OWNER FILE (doc 15 principle 10). The editable ones
// save through the guarded configuration store (D22); read-only sections name
// their owning document and say so.
//
// WHAT IS EDITABLE GREW ON 2026-09-05 (bead `ro-x5gu.6`). The collection cadence
// and the data-source catalog were the read-only half, because their files were
// not on the lane's allowlist. They are reachable now — the cadence as DECLARED
// KNOBS (`ro-x5gu.8`) and the catalog as a declared REGISTER (`ro-x5gu.1`) — so
// what this payload carries for them changed shape: the knobs are values keyed
// by their declaration, and the catalog rows are the file's own rows verbatim,
// because both are now things a save has to guard against.

import type { KnobFact, PortfolioKnob } from "./asset-detail";
import type { JsonValue } from "./changeset";
import type { ConfigKnobKey } from "./config-registers";
import type { EntityRow } from "./entities";
import type { DashboardConfig } from "./dashboard";
import type { CredentialScope, IntegrationLayer, LaneScope } from "./integrations";
import type { ScheduleOverrides } from "../../../scripts/scheduled-jobs.mjs";

/**
 * The clock the whole OS reads in (`config/constants.json` `os_time_zone`).
 *
 * One value, but its own section: it is not a budget and not a display choice,
 * it is the zone every intraday chart is re-bucketed into, and until bead
 * `ro-py40` it was a string literal in `packages/contract` that a self-hoster
 * in another timezone had to edit TypeScript to change.
 */
export interface ClockSettings {
  owner: string;
  /** An IANA zone name, validated at the build boundary. What the zone decides
   * is shown by the page as live values (the time, yesterday's revenue date, the
   * current month), never as a note — bead `ro-ujb9.96.6.3`. */
  timeZone: string;
  /** Somebody chose this clock (`timeZoneChosen`, bead `ro-ujb9.134`). While
   * false, a first run offers the browser's zone with one press. */
  chosen: boolean;
}

/** Portfolio spend caps + the operator's own rate (`config/constants.json`). */
export interface BudgetSettings {
  owner: string;
  knobs: PortfolioKnob[];
}

/** The anomaly-rule defaults every asset inherits (`config/constants.json`).
 * That scope is a chip in the section header, not a note (bead `ro-ujb9.96.6.3`). */
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

/**
 * One declared knob's current VALUE (bead `ro-x5gu.8`).
 *
 * The label, the rule and the consequence of changing it are deliberately NOT
 * here: they are the declaration in `scripts/config-registers.mjs`, which the
 * browser reads directly through `shared/config-registers.ts`. Carrying them in
 * the payload too would be a second copy of sentences that already have one
 * owner, and the two would drift.
 */
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
  /**
   * The saved job schedules (`config/constants.json` `/schedules`), VERBATIM —
   * or null while none has ever been saved (bead `ro-ujb9.96.7.12`).
   *
   * Carried here because each collection's schedule is edited in this section
   * now, and a schedule save is guarded by exactly this object. It is the same
   * document the local runner arms its timers from; what the runner actually
   * armed (next run, a pending change) stays System health's, read from the
   * runner itself.
   */
  schedules: ScheduleOverrides | null;
}

/**
 * One catalog lane, exactly as `config/integrations.json` `/catalog` holds it.
 *
 * VERBATIM SINCE BEAD `ro-x5gu.6`, and that is the point: `/settings` edits
 * these rows now, and an edit's `expect` is the concurrency guard, so a payload
 * that had helpfully defaulted a missing field would send a guard the file has
 * never agreed with. The register in `scripts/config-registers.mjs` decides what
 * each field may be; this type only says which of them are always there.
 *
 * STATE is deliberately absent — that is `/health`, read off evidence, and a
 * second rendering of it here would be a claim this page cannot back.
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
 * The portfolio's legal entities and the assets each one owns (bead `ro-aodz`).
 *
 * VERBATIM, for the reason the catalog above is: `/settings` edits these rows,
 * an edit's `expect` is the concurrency guard, and a payload that helpfully
 * filled in a missing `assets` would send a guard the file has never agreed
 * with. An entity that owns nothing carries no `assets` key at all, and the
 * difference between that and `[]` is what decides whether its first asset is a
 * first write or an ordinary one.
 */
export interface EntitiesSettings {
  owner: string;
  rows: EntityRow[];
}

/** One spoke of the shared task hub (`config/beads.json`): the asset, its bead
 * id prefix (`mp-1w2`), its Dolt database and the repo the work happens in. */
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

/**
 * How `bd` reaches the hub — READ-ONLY everywhere, and present only in a build
 * that has a filesystem (bead `ro-x5gu.5`).
 *
 * The port lives in THREE files that must agree — `config/beads.json`,
 * the installation's `dolt-server.yaml` and `CONFIG` in `scripts/runner/config.mjs` — and a test
 * pins them, so changing it here would be one of three edits and the surface
 * says so instead of offering a field. It crosses at all because the onboarding
 * command an operator runs after adding a project needs the exact host and port
 * to be copy-pasteable, and a fourth copy typed into this app would be exactly
 * the drift the invariant exists to prevent.
 *
 * `null` in a deployed build: the value is compiled out with the runner lane
 * (`vite.config.ts`), so the host project map is read-only and the local
 * onboarding checklist cannot appear. Other settings still save to the store.
 */
export interface TaskHubConnection {
  host: string;
  port: number;
  /** The MySQL user `bd` connects as — no password; the listener is loopback. */
  user: string;
  /** Repo-relative directory holding every database on the hub. */
  dataDir: string;
  /** Host-only helper prefix; absent from deployed builds and legacy hubs. */
  initCommand?: string;
  /** Offline repository preparation; no database or provider access. */
  contextCommand?: string;
}

export interface TaskHubSettings {
  owner: string;
  spokes: TaskHubSpoke[];
  hub: TaskHubConnection | null;
}

/** `config/beads.json` as the Tower reads it: the project map, plus the hub
 * connection on a build that has one (see `TaskHubConnection`). */
export interface BeadsConfig {
  spokes: TaskHubSpoke[];
  hub?: TaskHubConnection | null;
}

/** GET /api/settings — every portfolio-wide knob, in the order the page renders
 * them. The pure builder receives resolved store-first configuration and the
 * route's clock-selection evidence; it performs no reads itself. */
export interface SettingsPayload {
  generatedAt: string;
  /** The operator's clock (`config/constants.json`). */
  clock: ClockSettings;
  /** The shared TV display config (`config/tower.json`) — the countdown widget
   * renders and edits itself from this. Its `countdown` is optional, and the
   * page renders no TV section at all when it is absent (bead `ro-py40`). */
  dashboard: DashboardConfig;
  budget: BudgetSettings;
  alertRules: AlertRuleSettings;
  collection: CollectionSettings;
  sources: SourcesSettings;
  /** Who owns what (`config/entities.json`) — the portfolio-level fact D5 turns
   * on, and the list the asset page's Identity picker chooses from. */
  entities: EntitiesSettings;
  taskHub: TaskHubSettings;
}
