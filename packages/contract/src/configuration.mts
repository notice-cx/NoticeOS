/** Portable configuration meaning. No storage, bindings, or runtime globals. */
/** The exact documents resolved for one Tower request. Shared with the
 * hosted receiver, so a private caller cannot expand a settings read. */
export const TOWER_CONFIG_FILES = Object.freeze({
  constants: 'config/constants.json',
  pull: 'config/pull.json',
  integrations: 'config/integrations.json',
  counters: 'config/counters.json',
  dashboard: 'config/tower.json',
  serpPanel: 'config/serp-panel.json',
  signalPanels: 'config/signal-panels.json',
  valueEvents: 'config/value-events.json',
  ga4EventParams: 'config/ga4-custom-dimensions.json',
  domainCosts: 'config/domain-costs.json',
  recurringCosts: 'config/recurring-costs.json',
  entities: 'config/entities.json',
  beads: 'config/beads.json',
} as const);

export const ASSET_STATUSES = ['pre-launch', 'onboarding', 'baselining', 'live', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/**
 * A stage move is recorded as a timeline row because `assets.status` holds only
 * where an asset is; Restore reads the previous stage from the timeline. The
 * Tower and `pnpm config:apply` both write it, so both read these. The kind is
 * `config` because `annotations.kind` is a CHECK constraint and a stage is a
 * stored setting on the asset.
 */
export const LIFECYCLE_ANNOTATION_KIND = 'config';

/** What a lifecycle-move `ref` starts with, so an operator-written ref can never
 * be mistaken for one. */
export const LIFECYCLE_REF_PREFIX = 'lifecycle:';

/**
 * The `ref` one stage move is stored under (`lifecycle:baselining>retired`).
 * Part of the row's `(asset, at, kind, ref)` identity, so a retried write
 * collapses into one row and two moves in the same second stay two.
 */
export function lifecycleMoveRef(move: { from: AssetStatus; to: AssetStatus }): string {
  return `${LIFECYCLE_REF_PREFIX}${move.from}>${move.to}`;
}

export const STORE_COLUMNS = ['status', 'sense_only', 'display_name'] as const;
export type StoreColumn = (typeof STORE_COLUMNS)[number];
export const DISPLAY_NAME_MAX = 80;
export const ASSET_ID_MAX = 128;

// These existing vocabularies deliberately differ. A configuration reference
// does not create an asset; merging the rules would change accepted input.
export const ASSET_ID_RE = /^[a-z0-9.-]+$/;
export const CONFIG_ASSET_KEY_SOURCE = '[a-z0-9][a-z0-9._-]*';
export const CONFIG_ASSET_KEY_RE = new RegExp(`^${CONFIG_ASSET_KEY_SOURCE}$`);
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ── PostHog per-asset settings ──────────────────────────────────────────────
// One rule for three readers: the store save (scripts/config-registers.mjs
// `fieldRefusal`), the Tower's funnel editor, and the ingest collector, which
// refuses a funnel the save would have refused rather than sending it to
// PostHog. Plain functions, no schema library: the save path is plain Node.

/** PostHog Cloud regions. `us` is us.posthog.com, `eu` is eu.posthog.com. */
export const POSTHOG_HOSTS = ['us', 'eu'] as const;
export type PosthogHost = (typeof POSTHOG_HOSTS)[number];
/** A PostHog project id: digits only, as the project settings page shows it. */
export const POSTHOG_PROJECT_ID_SOURCE = '^[1-9][0-9]{0,11}$';
export const POSTHOG_FUNNEL_LIMITS = {
  maxFunnels: 10,
  minSteps: 2,
  maxSteps: 10,
  idMaxLength: 40,
  nameMaxLength: 80,
  eventMaxLength: 200,
  pathMaxLength: 300,
} as const;
/** A funnel id is a short kebab-case key, stable across renames of its name. */
export const POSTHOG_FUNNEL_ID_SOURCE = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
/** An event name as PostHog stores it (`$pageview`, `form_start`, `Sign up`).
 * Quotes, backslashes, braces and control characters are refused: the
 * collector passes names as query values, and a name no site would send is
 * more likely a paste error than an event. */
export const POSTHOG_EVENT_NAME_SOURCE = '^[$A-Za-z0-9_][A-Za-z0-9_ .:/$-]*$';
/** A page path, compared exactly with `$pathname`: starts with `/`, no query
 * string, no fragment, no spaces. */
export const POSTHOG_PATH_SOURCE = "^/[A-Za-z0-9._~!$&()*+,;=:@%/-]*$";

export interface PosthogFunnelStep {
  event: string;
  path?: string;
}
export interface PosthogFunnel {
  id: string;
  name: string;
  steps: PosthogFunnelStep[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Why a funnels list cannot be saved, as one sentence naming the funnel and
 * step, or null when it is fine. An empty list is valid: it means "no funnels",
 * and the collector skips the funnels family with that reason.
 */
export function posthogFunnelsRefusal(value: unknown, name = 'funnels'): string | null {
  const limits = POSTHOG_FUNNEL_LIMITS;
  if (!Array.isArray(value)) return `${name} must be a list of funnels`;
  if (value.length > limits.maxFunnels) return `${name} holds at most ${limits.maxFunnels} funnels`;
  const idRe = new RegExp(POSTHOG_FUNNEL_ID_SOURCE);
  const eventRe = new RegExp(POSTHOG_EVENT_NAME_SOURCE);
  const pathRe = new RegExp(POSTHOG_PATH_SOURCE);
  const seen = new Set<string>();
  for (const [index, funnel] of value.entries()) {
    const at = `${name}[${index + 1}]`;
    if (!isPlainObject(funnel)) return `${at} must be a funnel with an id, a name and steps`;
    const extra = Object.keys(funnel).find((key) => !['id', 'name', 'steps'].includes(key));
    if (extra !== undefined) return `${at} has an unknown field ${extra}; a funnel holds id, name and steps`;
    const { id, name: label, steps } = funnel;
    if (typeof id !== 'string' || id === '') return `${at} needs an id`;
    if (id.length > limits.idMaxLength || !idRe.test(id)) {
      return `${at} id must be lowercase letters, digits and dashes (${limits.idMaxLength} characters or fewer)`;
    }
    if (seen.has(id)) return `${at} repeats the funnel id ${id}`;
    seen.add(id);
    if (typeof label !== 'string' || label.trim() === '') return `${at} (${id}) needs a name`;
    if (label.length > limits.nameMaxLength) {
      return `${at} (${id}) name must be ${limits.nameMaxLength} characters or fewer`;
    }
    if (!Array.isArray(steps)) return `${at} (${id}) needs a list of steps`;
    if (steps.length < limits.minSteps || steps.length > limits.maxSteps) {
      return `${at} (${id}) needs ${limits.minSteps} to ${limits.maxSteps} steps`;
    }
    for (const [stepIndex, step] of steps.entries()) {
      const stepAt = `${at} (${id}) step ${stepIndex + 1}`;
      if (!isPlainObject(step)) return `${stepAt} must be an event, optionally with a path`;
      const stepExtra = Object.keys(step).find((key) => !['event', 'path'].includes(key));
      if (stepExtra !== undefined) return `${stepAt} has an unknown field ${stepExtra}; a step holds event and path`;
      const { event, path } = step;
      if (typeof event !== 'string' || event === '') return `${stepAt} needs an event name`;
      if (event.length > limits.eventMaxLength || !eventRe.test(event) || event.trim() !== event) {
        return `${stepAt} event must be an event name as PostHog shows it, such as $pageview or form_start`;
      }
      if (path !== undefined) {
        if (typeof path !== 'string' || path.length > limits.pathMaxLength || !pathRe.test(path)) {
          return `${stepAt} path must start with / and hold no spaces, query string or #`;
        }
      }
    }
  }
  return null;
}

// ── Assets that send no nightly report ──────────────────────────────────────
// The operator's declaration that an asset owes the OS no nightly report, so
// the report's absence is a state and never a failure. One list in the saved
// constants, written whole by the asset's Settings switch, read by the ingest
// freshness cron and by every Tower surface that counts the obligation. Whether
// a report is OWED is decided in `reporting.ts`; this is only where the list
// lives and what shape it may take.

/** The document that holds the declaration. */
export const NO_NIGHTLY_REPORT_FILE = 'config/constants.json';
/** Its one pointer: a list of asset ids. Absent until the first asset declares. */
export const NO_NIGHTLY_REPORT_POINTER = '/no_nightly_report';

/** Why a declaration list cannot be saved, or null when it can. */
export function noNightlyReportRefusal(value: unknown): string | null {
  if (!Array.isArray(value)) return 'The assets with no nightly report must be a list of asset ids';
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !CONFIG_ASSET_KEY_RE.test(id)) {
      return `${JSON.stringify(id)} is not an asset id`;
    }
    if (seen.has(id)) return `${id} is listed twice`;
    seen.add(id);
  }
  return null;
}

/** The pipeline's check for an op that touches the declaration: the list is
 * written whole, never one entry at a time, and must be a list of asset ids. */
export function noNightlyReportOpRefusal(op: {
  file?: unknown;
  pointer?: unknown;
  kind?: unknown;
  value?: unknown;
}): string | null {
  if (op.file !== NO_NIGHTLY_REPORT_FILE || typeof op.pointer !== 'string') return null;
  if (op.pointer !== NO_NIGHTLY_REPORT_POINTER && !op.pointer.startsWith(`${NO_NIGHTLY_REPORT_POINTER}/`)) {
    return null;
  }
  if (op.pointer !== NO_NIGHTLY_REPORT_POINTER) {
    return 'Save the assets with no nightly report as one list';
  }
  return op.kind === 'file-json-delete' ? null : noNightlyReportRefusal(op.value);
}

/**
 * The declared asset ids in a constants document, or null when it declares
 * none at all (the key is absent — the state a writer creates rather than
 * replaces). Total over an untrusted body: anything that is not a list of ids
 * reads as the ids it does hold, so one bad entry never silences the rest.
 */
export function noNightlyReportAssets(constants: unknown): string[] | null {
  if (!isPlainObject(constants) || !(NO_NIGHTLY_REPORT_POINTER.slice(1) in constants)) return null;
  const held = constants[NO_NIGHTLY_REPORT_POINTER.slice(1)];
  if (!Array.isArray(held)) return [];
  return held.filter((id): id is string => typeof id === 'string' && CONFIG_ASSET_KEY_RE.test(id));
}

// ── The older single-asset credential binding ───────────────────────────────
// One rule for every reader; no site is written down anywhere.

/**
 * Which asset an older single-asset binding serves: the first asset, in the
 * installation's own data-source register order (`config/integrations.json`
 * `/assets`, store first), whose entry has `lane`. Null, and the binding
 * serves no asset, when the register is missing or no asset has the lane.
 */
export function legacyBindingAsset(lane: string, register: unknown): string | null {
  if (!isPlainObject(register) || !isPlainObject(register.assets)) return null;
  for (const [asset, lanes] of Object.entries(register.assets)) {
    if (isPlainObject(lanes) && lane in lanes) return asset;
  }
  return null;
}

/** A guard states the value or the absence the writer observed, never both. */
export type FileJsonSetOp<File extends string = string> =
  | FileJsonSetGuardedOp<File>
  | FileJsonSetFirstOp<File>;
interface FileJsonSetBase<File extends string> {
  kind: 'file-json-set'; file: File; pointer: string; value: JsonValue;
}
export interface FileJsonSetGuardedOp<File extends string = string> extends FileJsonSetBase<File> {
  expect: JsonValue; expectAbsent?: never;
}
export interface FileJsonSetFirstOp<File extends string = string> extends FileJsonSetBase<File> {
  expect?: never; expectAbsent: true;
}
export interface FileJsonInsertOp<File extends string = string> {
  kind: 'file-json-insert'; file: File; pointer: string; value: JsonValue;
}
export interface FileJsonDeleteOp<File extends string = string> {
  kind: 'file-json-delete'; file: File; pointer: string; expect: JsonValue;
}
export interface StoreAssetSetOp<Column extends string = string> {
  kind: 'store-asset-set'; asset: string; column: Column; expect: JsonValue; value: JsonValue;
}
export type ChangesetOp = FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp | StoreAssetSetOp;
export interface Changeset<Op extends ChangesetOp = ChangesetOp> {
  version: 1; createdAt: string; slug: string; ops: Op[];
}

export type ConfigSource = 'store' | 'file';
export interface ConfigDocumentRead {
  file: string;
  // Recursive JSON types expand excessively through Worker RPC. Readers narrow
  // this untrusted body according to the document they requested.
  body: unknown;
  source: ConfigSource;
  version: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface ApplyConfigOpsInput<Op = ChangesetOp> {
  ops: Op[];
  expectVersions?: Record<string, number | null> | null;
  actor: string;
  reason?: string | null;
  slug?: string;
}
export interface ConfigWriteMismatch {
  file?: string; pointer?: string; asset?: string; column?: string;
  expect: unknown; expectAbsent?: true; current: unknown; absent: boolean;
}
export type ApplyConfigOpsResult =
  | { ok: true; applied: number; documents: { file: string; version: number; body: unknown }[] }
  | { ok: false; error: 'store_unavailable'; detail: string }
  | { ok: false; error: 'invalid_changeset'; detail: string }
  | { ok: false; error: 'store_op_not_accepted'; detail: string }
  | { ok: false; error: 'not_seeded'; detail: string; files: string[] }
  | { ok: false; error: 'version_mismatch'; files: { file: string; expected: number | null; observed: number }[] }
  | { ok: false; error: 'expect_mismatch'; mismatches: ConfigWriteMismatch[] };
