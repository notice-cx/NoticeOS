// config-registers.mts — WHAT THE TOWER MAY EDIT, DECLARED ONCE.
//
// Every list-shaped config register in this repo is described here: which file
// holds it, the JSON pointer of the container, whether that container is an
// ARRAY or an OBJECT keyed by something, which field identifies a row, and what
// each field is allowed to be. Nothing else in the system carries a second copy
// of any of it.
//
// WHY IT EXISTS. Before this module the answer to "what may be edited" lived in
// two hand-kept constants inside scripts/config-apply-core.mjs — `ALLOWED_FILES`
// (a value may be SET in these four files) and `ADDABLE_CONTAINERS` (this one
// container per file may GROW by one asset entry) — and the field rules lived
// nowhere at all: whoever built a changeset was trusted to put a number where a
// number went. Epic `ro-x5gu` puts a CRUD surface on every register at once, so
// five UIs were about to be built in parallel; without one declaration each of
// them would have invented its own list editor, its own allowlist line and its
// own idea of what a valid row is, and the write lane would have ended up with
// five hand-kept allowlists to keep in step.
//
// ONE REPRESENTATION, TWO READERS (doc 14). This file is authored TypeScript
// with no dependencies (bead ro-ujb9.61): `pnpm config:generate` writes the
// plain-ESM `config-registers.mjs` that `scripts/config-apply-core.mjs` and the
// config pipeline import without a build step, and the `config-registers.d.mts`
// beside it. The Tower's TypeScript reaches the identical object through
// `apps/tower/shared/config-registers.ts`, a thin typed re-export, and compiles
// against the declarations below rather than a hand-kept copy of them — so every
// register and knob is checked against its shape where it is written. The
// browser validates a row before it sends one; the lane validates it again
// because an HTTP body is untrusted. Both are reading these same declarations,
// so a field cannot be accepted on one side and refused on the other.
//
// WHAT A DECLARATION LICENSES, exactly:
//   - `file-json-insert` at the container's own append/key pointer,
//   - `file-json-delete` at one row's pointer,
//   - `file-json-set` at `<container>/<row>/<declared field>` — and only there,
//     validated by that field's type.
// A register whose `fields` is `null` is OPAQUE: its rows may be added and
// removed whole (that is the add-asset wizard's permission, bead `ro-z349.1`)
// and nothing inside them may be set through the register. Being able to add an
// asset's entry and being able to rewrite one are different permissions, and
// they stay refusable separately.
//
// THE SCALAR KNOBS BESIDE THOSE LISTS are declared here too, in `CONFIG_KNOBS`
// (bead `ro-x5gu.8`): one entry per POINTER — `config/signal-panels.json`
// `/refresh/windowDays` and `/refresh/freshnessMaxAgeDays`. A knob licenses `file-json-set` at that exact
// pointer and nowhere else, validated by the same `RegisterField` a column
// carries. It exists because a register only licenses its own list, those files
// are deliberately not wholesale-settable, and the numbers in them are settings
// an operator changes from `/settings` rather than facts a lane derives.
//
// ADDING A REGISTER (or a knob) is this file plus a line in
// config/changesets/README.md. The refusals, the CLI, the write lane and the
// Tower's CollectionEditor / KnobEditor all follow from the declaration; none of
// them needs a change.

/** Configuration references have their own spelling rule; they do not create
 * an asset. The portable contract also owns the stricter creation vocabulary. */
import {
  ASSET_ID_MAX,
  ASSET_ID_RE,
  ASSET_STATUSES,
  CONFIG_ASSET_KEY_SOURCE as ASSET_ID_SOURCE,
  DISPLAY_NAME_MAX,
  DOMAIN_RE,
  POSTHOG_HOSTS,
  POSTHOG_PROJECT_ID_SOURCE,
  posthogFunnelsRefusal,
} from '../packages/contract/src/configuration.mjs';
import type { JsonValue } from '../packages/contract/src/configuration.mjs';
export type { JsonValue } from '../packages/contract/src/configuration.mjs';
export { ASSET_ID_SOURCE };
import {
  PRODUCT_USE_GROUPS, PRODUCT_USE_EVENT_MAX_LENGTH, PRODUCT_USE_LABEL_MAX_LENGTH,
  PRODUCT_USE_EVENT_PATTERN,
} from '../packages/contract/src/product-use.mjs';

/** What a field may hold. The type decides the refusal AND the control the
 * Tower renders, so there is no second table mapping one to the other. */
export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'month'
  | 'url'
  /** A reference to a site from a configuration file (the configuration key
   * spelling, `CONFIG_ASSET_KEY_SOURCE`). */
  | 'asset-id'
  /** A site's own id in the store (`ASSET_ID_RE`) — the `assets` row's key and
   * what every store lane names a site by (`SITE_ROW_FIELDS`). A different
   * spelling rule from `asset-id`, read out in the same words. */
  | 'store-asset-id'
  /** A hostname such as example.com (`DOMAIN_RE`) — no scheme, no path. */
  | 'domain'
  | 'string-list'
  /** A PostHog funnels list (bead `ro-ghis.1`): judged whole by
   * `posthogFunnelsRefusal` in the portable configuration contract. */
  | 'posthog-funnels';

export interface RegisterField {
  /** The JSON key inside a row — also the last pointer token of a `file-json-set`. */
  name: string;
  /** The column heading and the input's label. */
  label: string;
  type: FieldType;
  required: boolean;
  /** The hint under the Add form's input and the column heading's hover: a
   * format or an example, label-length (the hint is read at a glance; `pnpm ux:gate`
   * lists long ones). What a field MEANS is its label; what it may hold is its type
   * and rule; a warning about editing it is a rule (`readOnly`), never a
   * sentence here. */
  describe: string;
  /** `enum` only — the complete set of accepted values. */
  values?: readonly string[];
  /** `enum` only — what a value reads as on screen, where the stored value is
   * a key nobody should have to learn (bead `ro-ujb9.135`). The file keeps the
   * value; a value with no entry here shows as itself. */
  valueLabels?: Readonly<Record<string, string>>;
  /** `number` / `integer` bounds. */
  min?: number;
  max?: number;
  /** `string`-ish limits. */
  maxLength?: number;
  /** A RegExp source the whole value must match. */
  pattern?: string;
  /** Another field of the same row whose value this one takes until it is typed
   * into directly — an Add-form default, never a stored derivation (the file
   * keeps both values, because the equality is a convention, not a rule). */
  defaultFrom?: string;
  /**
   * What a RUNTIME candidate list means for this field (bead `ro-g318`).
   * `'closed'` (the default) — the values a page supplies are the whole value
   * domain, and anything else is refused naming the field; `'suggest'` — they
   * are what is already in use, offered as a picker, and a value outside them
   * is a legitimate edit. The picker and the allowlist were one prop until the
   * tracked-query Bet column needed the first without the second.
   */
  candidates?: 'closed' | 'suggest';
  /**
   * This field may be set when the row is CREATED and not afterwards (bead
   * `ro-xhy5`) — a join key whose rename breaks something no table can show.
   * The editor renders it as the value with a lock and the state "Fixed once
   * added" (`fixedFieldLabel`), the Add form marks it before it is typed, and
   * the write lane refuses the set as well, so "read-only" is a rule rather
   * than a suggestion a hand-written changeset can walk past. The way to
   * change one is the row's own Remove and the table's Add, both on screen.
   */
  readOnly?: boolean;
  /** A different STATE than "fixed once added", label-length, for a field no
   * surface here ever writes (the task project's host-linked repository).
   * Only meaningful beside `readOnly`. Never a rationale: why a key is fixed
   * is this file's comment, not the operator's reading. */
  readOnlyReason?: string;
}

/** One "changing X dates Y" pair a register declares (bead `ro-6kd6`). Both
 * names are fields of that register. */
export interface RegisterStamp {
  /** The field whose CHANGE is the decision. */
  when: string;
  /** The date field set to the day the change was applied. */
  field: string;
}

export interface ConfigRegister {
  /** Repo-relative path of the file holding the container. */
  file: string;
  /** RFC-6901 pointer to the container. May carry `{asset}` — see ASSET_PARAM. */
  container: string;
  /** An array of rows, or an object whose keys are the rows. */
  shape: 'array' | 'object';
  /** `object` shape only: what a key must look like. `lane-id` is the one
   * register keyed by something other than an asset — the data-source lanes
   * inside one asset's entry (bead `ro-vu8d.4`). */
  keyRule?: 'asset-id' | 'lane-id';
  /** `array` shape: the field that identifies a row. Absent or `null` for an object shape. */
  keyField?: string | null;
  /** Further fields no two rows may share. The key field is unique by
   * definition and is not repeated here. */
  unique?: readonly string[];
  /**
   * The row's fields, in column order (the key field first). `null` means the
   * row is OPAQUE: it may be added and removed whole, and nothing inside it may
   * be set through this register.
   */
  fields: readonly RegisterField[] | null;
  /** When set, a row MAY be the bare value of that one field rather than an
   * object wrapping it (a string list; a tracked query with no cluster). */
  scalarField?: string;
  /**
   * The field that names the GROUP a row belongs to, where grouping downstream
   * is an exact string match (bead `ro-cnsj`). Two spellings of one group are
   * two groups in the readout and one in the operator's head, so a near miss is
   * refused where it is typed — `clusterSpellingRefusal`.
   */
  clusterField?: string;
  /** This file has NO empty state for the list: an entry holding `[]` is a
   * config error there, and absence is how "none" is said. So the last row out
   * takes the asset's whole entry with it, exactly as the first row in filed
   * one. Only for a per-asset list (one with a `holderOf` holder). */
  emptyIsAbsent?: boolean;
  /** This exact per-asset list may be initialized beside another holder field.
   * Its parent must already exist; no arbitrary parent structure is created. */
  addableContainer?: boolean;
  /** First-row Undo removes this list only, preserving a shared holder. */
  seedUndo?: 'list';
  /**
   * This register's rows carry a claim about ANOTHER file that no field of a row
   * can check (bead `ro-uko8`): `enabled` on the panel-refresh roster asserts
   * that the asset has a live search lane in `config/integrations.json`. The
   * rule is `liveSearchLaneRefusal`; the facts come from whoever holds them.
   */
  requiresLiveSearchLane?: boolean;
  /**
   * Dates this register's rows carry that a write MOVES (bead `ro-6kd6`): when
   * a set changes the `when` field of a row, the pipeline sets that row's
   * `field` to the day it applied. The roster's `since` means "when the decision
   * was taken" and `enabled` is the decision, so editing them as two independent
   * cells left a flipped row claiming a day it was not decided on.
   */
  stamps?: readonly RegisterStamp[];
  /** A register an asset is BORN into and DELETED out of — the add-asset wizard
   * (bead `ro-z349.1`) and the Settings tab's Delete (bead `ro-sk7q`). The set
   * `ADDABLE_CONTAINERS` is derived from it, and a new one here also belongs in
   * the delete's own list of files it clears. */
  assetRegister?: boolean;
  /** The register's name in the UI. */
  label: string;
  /** What one row IS, label-length: the CLI refusal names the register by it
   * and the Tower shows it under the table's title. */
  describe: string;
  /** The README that owns the concept. */
  owner: string;
  /** Where an operator edits it. */
  surface: string;
}

export type ConfigRegisterKey =
  | 'product-use-stages'
  | 'asset-integrations'
  | 'asset-lane'
  | 'asset-counters'
  | 'asset-pull'
  | 'domain-costs'
  | 'recurring-costs'
  | 'value-events'
  | 'value-events-assets'
  | 'ga4-event-params'
  | 'ga4-event-params-assets'
  | 'serp-panel-queries'
  | 'serp-panel-assets'
  | 'signal-panels'
  | 'task-hub-spokes'
  | 'data-source-catalog'
  | 'entities';

/**
 * What a collector reads for an asset that maps NOTHING on a lane (bead
 * `ro-vu8d.16`), as a code the card draws as a chip (bead `ro-ujb9.96.6.4`)
 * rather than a sentence:
 *
 *  - `google-account-map` — the Google credential's own per-asset map
 *    (`GOOGLE_SIGNAL_ACCOUNTS → properties → <asset> → ga4_property_id /
 *    gsc_site_url`). An install that signed in with Google has no such map, so
 *    it collects nothing until a value is saved. Once every asset the
 *    credential names is mapped here, the collector stops reading that map at
 *    all (bead `ro-90mr`).
 *  - `domain-match` — the asset's own domain matched against the sites the
 *    central Bing account lists as verified; no match fails loudly. A saved
 *    site is what tells two verified sites on one host apart.
 *  - `portfolio-market` — the portfolio baseline market, location 2840
 *    (United States) and language `en`. A field left empty takes the baseline;
 *    a wrong location buys the wrong market's data at the same price.
 *  - `none` — nothing to fall back to: the lane skips this asset and records
 *    why (PostHog has no portfolio-wide project, and a guessed one would read
 *    another site's data).
 */
export type LaneFallback = 'google-account-map' | 'domain-match' | 'portfolio-market' | 'none';

/**
 * One data-source lane's mapping fields, and what the collector reads when
 * THIS asset maps nothing (bead `ro-vu8d.4`). Only the lanes that HAVE a
 * per-asset mapping appear; every other lane's card renders none. A mapped lane
 * needs no code: the collector asks for the saved value, and the card says
 * "Mapped here".
 */
export interface LaneMapping {
  /** Field names of `asset-lane`, in the order the card renders them. */
  fields: readonly string[];
  /** Structured fields saved as one list value, rendered by their own editor
   * below the scalar fields and not counted as the mapping step (bead
   * `ro-ghis.1`: PostHog's funnels). */
  lists?: readonly string[];
  /** What an UNMAPPED lane reads instead (bead `ro-vu8d.16`). */
  fallback: LaneFallback;
}

/**
 * ONE SCALAR SETTING, at one exact pointer (bead `ro-x5gu.8`).
 *
 * A register describes a list; this describes a single number or string sitting
 * beside one, in a file that is deliberately not wholesale-editable. It carries
 * a whole `RegisterField` rather than a bare type so the refusal an operator
 * reads is written in exactly one place, shared with every register column.
 */
export interface ConfigKnob {
  /** Repo-relative path of the file holding it. */
  file: string;
  /** The RFC-6901 pointer — exact; nothing above or below it is licensed. */
  pointer: string;
  /** The knob's name in the UI. */
  label: string;
  /** Display unit beside the control; it does not change the stored value. */
  unit: string;
  /** The rule, spelled as a register column is. `name` is the pointer's last
   * reference token, so a refusal names the key the file actually holds.
   * What changing it COSTS is not a sentence here: /settings draws it as the
   * value beside the field (`collectionVisual`, bead `ro-ujb9.96.6.3`). */
  field: RegisterField;
  /** The README that owns the concept. */
  owner: string;
  /** Where an operator edits it. */
  surface: string;
}

export type ConfigKnobKey =
  | 'panel-refresh-window'
  | 'panel-freshness-bar';

export interface KnobMatch {
  key: ConfigKnobKey;
  knob: ConfigKnob;
}

export interface RegisterMatch {
  key: ConfigRegisterKey;
  register: ConfigRegister;
  /** Reference tokens past the container: `[]`, `["3"]`, `["3","domain"]`. */
  rest: string[];
  /** The asset a per-asset container matched. */
  params: { asset?: string };
  /** The container as it appeared in the pointer, `{asset}` already filled. */
  container: string;
}

/** The whole-asset register a per-asset list's entry has to be filed in first. */
export interface RegisterHolder {
  key: ConfigRegisterKey;
  register: ConfigRegister;
  /** The key inside the holder's entry the list lives at (`valueEvents`). */
  field: string;
}

/** A parsed document read by key: an object of unknown shape. */
type Row = { readonly [key: string]: unknown };

/** The token that marks the per-asset hole in a container pointer. A register
 * carrying one is scoped to a single asset: `/assets/{asset}/valueEvents` is a
 * different collection for every asset, and the surface editing it is that
 * asset's own page. */
export const ASSET_PARAM: string = '{asset}';

/** Data-source lane ids are the catalog's own join keys (`ga4`,
 * `bing-webmaster`, `affiliate-cj`) — the same shape `data-source-catalog`
 * declares for its `id` column, repeated here because it is what a KEY may look
 * like rather than what a field may hold. `scripts/config-registers.test.mjs`
 * asserts every committed lane key matches it. */
export const LANE_ID_SOURCE: string = '[a-z0-9]+(?:-[a-z0-9]+)*';

/**
 * The registers, keyed by the name a UI passes.
 *
 * Field order is COLUMN ORDER — the key field first, then what an operator reads
 * next. `describe` is one line, and it is the same line the CLI prints in a
 * refusal and the Tower shows above the table; two sentences would drift.
 */
export const CONFIG_REGISTERS: Record<ConfigRegisterKey, ConfigRegister> = {
  // ── the three per-asset registers the add-asset wizard writes (ro-z349.1) ──
  // Add a site in one screen since ro-ujb9.96.7.5; the counters and pull entries
  // it no longer asks for are added whole from the asset's Settings tab.
  // Opaque on purpose: the wizard composes a whole entry, and no surface edits
  // one field of one through a register. `config/integrations.json` is ALSO
  // freely settable (below), which is how an asset's lane status is still
  // written; `config/counters.json` is not, and that asymmetry is the point.
  'asset-integrations': {
    file: 'config/integrations.json',
    container: '/assets',
    shape: 'object',
    keyRule: 'asset-id',
    keyField: null,
    fields: null,
    label: 'Site data sources',
    describe: "one site's data sources",
    owner: 'config/integrations.README.md',
    surface: 'Add a site (/assets/new)',
    assetRegister: true,
  },
  // ── the per-asset LANE register the Sources tab edits (ro-vu8d.4) ─────────
  //
  // One row is one (asset, data source) cell of config/integrations.json: the
  // posture the operator declared, the reason behind it, and WHICH property /
  // site / scope this asset maps to on that provider. Until this declaration
  // the mapping was hand-edited JSON and the file's own rules lived only in its
  // README, so a typo'd property id was found by a failing collector run.
  //
  // DECLARED AFTER `asset-integrations`, and the order matters exactly once:
  // `rowMatch` (add/remove) takes the FIRST register whose container matches, so
  // the wizard's insert of a whole asset entry at `/assets/<asset>` keeps
  // resolving to the holder above rather than to this. `matchRegister` (set)
  // takes the LONGEST container, so a pointer INSIDE an asset —
  // `/assets/example.com/ga4/propertyId` — resolves here and is field-checked.
  //
  // `config/integrations.json` is also in `SETTABLE_FILES`, so this register is
  // not what makes the file writable; it is what makes a write to it JUDGED.
  'asset-lane': {
    file: 'config/integrations.json',
    container: `/assets/${ASSET_PARAM}`,
    shape: 'object',
    // The keys here are LANE ids, not asset ids — the one register in this map
    // whose rows are keyed by something else, which is why `keyRule` exists as
    // a name rather than an assumption.
    keyRule: 'lane-id',
    keyField: null,
    label: 'Site data sources',
    // Its posture, the reason, and which property it maps to.
    describe: 'one data source on one site',
    owner: 'config/integrations.README.md',
    surface: "the site's Sources tab",
    // A POSTURE IS DATED BY THE PIPELINE (bead `ro-t7fz`). `since` is defined as
    // "when this posture was recorded", and the Sources tab writes `status` and
    // `note` as two independent cells with no date field at all — so declining
    // a source left `since` naming the day the PREVIOUS posture was recorded,
    // with no surface able to correct it. The same defect the roster register
    // fixed for `enabled` (ro-6kd6), and the same one-line answer: the date
    // moves with the decision, for the click, for `pnpm config:apply` and for
    // a deployed Save alike. A note-only edit moves nothing.
    stamps: [{ when: 'status', field: 'since' }],
    fields: [
      {
        name: 'status',
        label: 'Posture',
        type: 'enum',
        required: true,
        values: ['live', 'degraded', 'needs-setup', 'skipped', 'not-applicable'],
        // The file-owned SCOPE decision: health is observed from collector runs
        // and is never written here.
        describe: 'set up, or skipped with a reason',
      },
      {
        name: 'note',
        label: 'Reason',
        type: 'string',
        // ABSENT UNTIL THERE IS SOMETHING TO SAY (bead `ro-ujb9.96.7.22`): a
        // new site's sources start with no note, never a blank one this field
        // would refuse on the next write — so a first "Not using" writes its
        // reason as a first write, and its Undo takes the key off again. A
        // blank note is still refused ("must not be blank").
        required: false,
        // ONE LINE (bead `ro-ujb9.96.6.4`): why the source is skipped, or what
        // blocks it. It is shown whole on the Sources tab, so the cap keeps it
        // a reason rather than a log; proof lives in collector runs and history
        // in git. A skipped source's note must match /reason/i
        // (config/integrations.README.md).
        maxLength: 90,
        describe: 'one line: why skipped, or what blocks it',
      },
      {
        name: 'ref',
        label: 'Source pointer',
        type: 'string',
        required: false,
        maxLength: 200,
        describe: 'which credential reaches this site — a convention or placeholder, never a secret',
      },
      {
        name: 'since',
        label: 'Since',
        type: 'date',
        required: true,
        describe: 'when this posture was recorded, YYYY-MM-DD',
      },
      // ── the mapping fields (see LANE_MAPPING below for who shows which) ────
      {
        name: 'mediavineSiteId', label: 'Mediavine site', type: 'string', required: false,
        maxLength: 160, pattern: '^[A-Za-z0-9+/=_-]+$',
        describe: 'copy the site id from Mediavine',
      },
      {
        name: 'mediavineEnabled', label: 'Automatic Mediavine sync', type: 'boolean', required: false,
        describe: 'collect yesterday at 6:10 a.m. Pacific; disabling preserves saved revenue',
      },
      {
        name: 'revenueHolidayCalendar', label: 'Revenue forecast holiday calendar', type: 'enum', required: false,
        values: ['none', 'US', 'CA', 'US,CA'],
        describe: 'holidays compared with this site’s traffic',
      },
      {
        name: 'propertyId',
        label: 'GA4 property id',
        type: 'string',
        required: false,
        maxLength: 20,
        // Digits only. The Data API addresses a property as `properties/<id>`,
        // and pasting that whole string is the mistake this pattern catches.
        pattern: '^[1-9][0-9]{4,14}$',
        describe: 'digits only, e.g. 313598867',
      },
      {
        name: 'siteUrl',
        label: 'Site',
        type: 'string',
        required: false,
        maxLength: 253,
        // Search Console accepts a domain property (`sc-domain:example.com`) or
        // a URL-prefix property; Bing Webmaster only ever a URL. One pattern
        // covers both because one field holds both, and the surface's own copy
        // says which form its lane wants.
        pattern: '^(?:sc-domain:[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}|https?://\\S+)$',
        describe: 'use sc-domain:example.com or https://example.com/',
      },
      {
        name: 'locationCode',
        label: 'Location',
        type: 'integer',
        required: false,
        min: 1,
        max: 99999999,
        describe: "DataForSEO's numeric location code — 2840 is the United States, the portfolio baseline",
      },
      {
        name: 'languageCode',
        label: 'Language',
        type: 'enum',
        required: false,
        values: ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'pl'],
        describe: "DataForSEO's language code — 'en' is the portfolio baseline",
      },
      // ── PostHog (bead ro-ghis.1) ─────────────────────────────────────────
      {
        name: 'host',
        label: 'PostHog region',
        type: 'enum',
        required: false,
        values: [...POSTHOG_HOSTS],
        describe: 'us or eu',
      },
      {
        name: 'projectId',
        label: 'PostHog project id',
        type: 'string',
        required: false,
        maxLength: 12,
        pattern: POSTHOG_PROJECT_ID_SOURCE,
        describe: "the number in the project's URL (us.posthog.com/project/596607), digits only",
      },
      {
        name: 'funnels',
        label: 'Funnels',
        type: 'posthog-funnels',
        required: false,
        // The journeys the daily product analytics archive counts, in order;
        // each step is an event name, optionally pinned to one page path.
        describe: '2 to 10 steps each, in order',
      },
    ],
  },
  'asset-counters': {
    file: 'config/counters.json',
    container: '/assets',
    shape: 'object',
    keyRule: 'asset-id',
    keyField: null,
    fields: null,
    label: 'Site counter cards',
    describe: "one site's counter cards",
    owner: 'config/counters.README.md',
    surface: "Add a site, then the site's Settings tab (Card totals)",
    assetRegister: true,
  },
  'asset-pull': {
    file: 'config/pull.json',
    container: '',
    shape: 'array',
    keyField: 'asset',
    fields: null,
    label: 'Site metrics endpoints',
    describe: "one site's own metrics endpoint",
    owner: 'config/pull.README.md',
    surface: "Add a site, then the site's Settings tab (Fetch from an endpoint)",
    assetRegister: true,
  },

  // ── the money registers /financials edits (ro-x5gu.2) ──────────────────────
  'domain-costs': {
    file: 'config/domain-costs.json',
    container: '/domains',
    shape: 'array',
    keyField: 'domain',
    label: 'Domain orders',
    // What a row IS. How it books — the price over the 12 months from the
    // month it was paid — is the table's own "Per month" column on
    // /financials (amount and first → last month), so a sentence saying it
    // restated a column (bead `ro-ujb9.96.6.17`).
    describe: 'one prepaid domain order',
    owner: 'config/domain-costs.README.md',
    surface: '/financials',
    fields: [
      {
        name: 'domain',
        label: 'Domain',
        type: 'string',
        required: true,
        maxLength: 253,
        pattern: '^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$',
        describe: 'lowercase, a name not a URL: example.com',
        // FIXED ONCE ADDED: the row records what a registrar charged for THIS
        // name, and the name is what the next export is reconciled against —
        // the way back from the wrong one is removing the order and recording
        // the right one, which is also what the money did.
        readOnly: true,
      },
      {
        name: 'asset',
        label: 'Site',
        type: 'asset-id',
        required: true,
        describe: 'the site that carries the cost',
      },
      {
        name: 'kind',
        label: 'Order',
        type: 'enum',
        required: true,
        values: ['registration', 'renewal', 'transfer'],
        describe: 'what was bought',
      },
      {
        name: 'paidUsd',
        label: 'Paid (USD)',
        type: 'number',
        required: true,
        min: 0,
        // The receipt, because a promo price is the honest figure and the
        // renewal price is not.
        describe: 'as charged on the receipt',
      },
      {
        name: 'paidOn',
        label: 'Paid on',
        type: 'date',
        required: true,
        describe: 'the receipt date',
      },
    ],
  },
  'recurring-costs': {
    file: 'config/recurring-costs.json',
    container: '/costs',
    shape: 'array',
    keyField: 'id',
    label: 'Recurring costs',
    describe: 'one unmetered subscription, booked every month it runs',
    owner: 'config/recurring-costs.README.md',
    surface: '/financials',
    fields: [
      {
        name: 'id',
        label: 'Id',
        type: 'string',
        required: true,
        maxLength: 64,
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        describe: 'lowercase-with-dashes: claude-code',
        // FIXED ONCE ADDED: the id is part of the ledger's idempotency key, so
        // every month already booked was booked under it and a rename would
        // book all of them again under the new one.
        readOnly: true,
      },
      { name: 'label', label: 'Label', type: 'string', required: true, maxLength: 80, describe: 'what the charge is called on the statement' },
      {
        name: 'asset',
        label: 'Site',
        type: 'asset-id',
        required: true,
        describe: 'who carries it — the OS for anything portfolio-wide',
      },
      {
        name: 'family',
        label: 'Family',
        type: 'enum',
        required: true,
        values: ['inference', 'api', 'infra', 'operator', 'os-overhead'],
        // The values are the ledger's CHECK constraint on cost families.
        describe: 'the ledger group it books under',
      },
      {
        name: 'amountUsdPerMonth',
        label: 'USD / month',
        type: 'number',
        required: true,
        min: 0,
        describe: 'the recurring charge',
        // FIXED ONCE ADDED (bead `ro-ujb9.96.6.17`), for the reason Stripe
        // gives for a price's amount: every month already booked was booked at
        // this figure, and cost-import refuses a replay whose amount moved
        // (`conflicting_replay`). A price change is two controls already on
        // the table — this row's To, then Add for the new price — rather than
        // an in-place edit a sentence under the To column had to forbid.
        readOnly: true,
      },
      { name: 'from', label: 'From', type: 'month', required: true, describe: 'first month to book, YYYY-MM' },
      {
        name: 'to',
        label: 'To',
        type: 'month',
        required: false,
        describe: 'last month to book, YYYY-MM',
      },
      { name: 'note', label: 'Note', type: 'string', required: false, maxLength: 400, describe: "copied onto each month's cost" },
    ],
  },

  // ── the two GA4 declarations an asset's Sources tab edits (ro-x5gu.3) ──────
  // Both are per-asset string lists, so both are SCALAR registers: a row is the
  // string itself, not an object wrapping it.
  //
  // Each is DECLARED TWICE, and it has to be. The list register reaches
  // `/assets/<asset>/valueEvents` — which only exists once that asset has an
  // entry at all — and an asset with no entry is the common case in every one of
  // these files (absence is "not declared", deliberately). A pointer never
  // creates structure, so the surface needs a way to file the asset's HOLDER
  // first: that is the `-assets` register beside it, opaque, keyed by asset id,
  // exactly like the wizard's three.
  //
  // The holder is declared FIRST so a refusal names the whole-asset pointer
  // before the deeper one, which is the order somebody reading it needs; which
  // register OWNS a pointer is decided by the longest matching container rather
  // than by this order (`matchRegister`), so the list always wins inside itself.
  //
  // BOTH HOLDERS ARE ASSET REGISTERS (bead `ro-vyer`, 2026-09-05). A deleted
  // asset used to leave its declaration behind in both files and the
  // confirmation never named them — the same gap `ro-sk7q` closed for the two
  // panel files, and one that got FASTER once the Sources tab could file an
  // entry with a click. An asset's own GA4 declarations are part of what the
  // asset IS, so they go with it. They are not written on Create, though: the
  // wizard has nothing to declare yet, and an entry holding `[]` is a claim
  // ("this asset declares no value events") nobody has made.
  'value-events-assets': {
    file: 'config/value-events.json',
    container: '/assets',
    shape: 'object',
    keyRule: 'asset-id',
    keyField: null,
    fields: null,
    label: 'Sites declaring value events',
    describe: "one site's value-event declaration, holding its list",
    owner: 'config/value-events.README.md',
    surface: "the site's Sources tab",
    assetRegister: true,
  },
  'value-events': {
    file: 'config/value-events.json',
    container: `/assets/${ASSET_PARAM}/valueEvents`,
    shape: 'array',
    keyField: 'event',
    scalarField: 'event',
    addableContainer: true,
    label: 'Value events',
    describe: 'one GA4 event this site calls a value event',
    owner: 'config/value-events.README.md',
    surface: "the site's Sources tab",
    fields: [
      {
        name: 'event',
        label: 'GA4 event',
        type: 'string',
        required: true,
        maxLength: 40,
        pattern: '^[A-Za-z][A-Za-z0-9_]*$',
        describe: 'verbatim as the site emits it (calculation_complete, never "Calculation complete")',
      },
    ],
  },
  'product-use-stages': {
    file: 'config/value-events.json',
    container: `/assets/${ASSET_PARAM}/productUseStages`,
    shape: 'array',
    keyField: 'eventName',
    addableContainer: true,
    seedUndo: 'list',
    label: 'Product use stages',
    describe: 'saved event counts shown in Product use',
    owner: 'config/value-events.README.md',
    surface: "the site's Sources tab",
    fields: [
      { name: 'eventName', label: 'GA4 event', type: 'string', required: true,
        maxLength: PRODUCT_USE_EVENT_MAX_LENGTH, pattern: PRODUCT_USE_EVENT_PATTERN, describe: 'the saved event name' },
      { name: 'label', label: 'Label', type: 'string', required: true,
        maxLength: PRODUCT_USE_LABEL_MAX_LENGTH, describe: 'the stage heading' },
      { name: 'group', label: 'Group', type: 'enum', required: true,
        values: PRODUCT_USE_GROUPS, describe: 'the display group' },
      { name: 'compareTo', label: 'Compare to event', type: 'string', required: false,
        maxLength: PRODUCT_USE_EVENT_MAX_LENGTH, pattern: PRODUCT_USE_EVENT_PATTERN, describe: 'another declared event volume' },
      { name: 'comparisonLabel', label: 'Comparison label', type: 'string', required: false,
        maxLength: PRODUCT_USE_LABEL_MAX_LENGTH, describe: 'the independent-volume comparison heading' },
    ],
  },
  'ga4-event-params-assets': {
    file: 'config/ga4-custom-dimensions.json',
    container: '/assets',
    shape: 'object',
    keyRule: 'asset-id',
    keyField: null,
    fields: null,
    label: 'Sites with registered dimensions',
    describe: "one site's registered-dimension declaration, holding its list",
    owner: 'config/ga4-custom-dimensions.README.md',
    surface: "the site's Sources tab",
    assetRegister: true,
  },
  'ga4-event-params': {
    file: 'config/ga4-custom-dimensions.json',
    container: `/assets/${ASSET_PARAM}/eventParams`,
    shape: 'array',
    keyField: 'param',
    scalarField: 'param',
    label: 'Registered event parameters',
    describe: 'a parameter registered as a GA4 custom dimension',
    owner: 'config/ga4-custom-dimensions.README.md',
    surface: "the site's Sources tab",
    fields: [
      {
        name: 'param',
        label: 'Parameter',
        type: 'string',
        required: true,
        maxLength: 40,
        pattern: '^[A-Za-z][A-Za-z0-9_]*$',
        // As the emitter names it, never as the Data API addresses it
        // (customEvent:message).
        describe: 'as the site sends it, e.g. message',
      },
    ],
  },

  // ── the two tracked-panel registers an asset's Growth tab edits (ro-x5gu.4) ─
  //
  // Both `/assets` containers are ASSET REGISTERS (bead `ro-sk7q`): an asset is
  // deleted out of them by the Settings tab's Delete, which lists every file it
  // removes the asset from, and the add-asset wizard files the roster row
  // because config/signal-panels.README.md makes membership an invariant. That
  // is why they carry `assetRegister` and appear in `ADDABLE_CONTAINERS`.
  'serp-panel-assets': {
    file: 'config/serp-panel.json',
    container: '/assets',
    shape: 'object',
    keyRule: 'asset-id',
    keyField: null,
    fields: null,
    label: 'Sites buying a tracked panel',
    describe: "one site's tracked-query panel, holding its terms",
    owner: 'config/serp-panel.README.md',
    surface: "the site's Growth tab",
    assetRegister: true,
  },
  'serp-panel-queries': {
    file: 'config/serp-panel.json',
    container: `/assets/${ASSET_PARAM}/queries`,
    shape: 'array',
    keyField: 'query',
    // An entry may be a bare string OR `{query, label}` — both are valid, in any
    // mix (config/serp-panel.README.md). A row with no label writes the string.
    scalarField: 'query',
    // WHICH FIELD IS THE CLUSTER KEY (bead `ro-cnsj`). Grouping is an exact
    // string match on the stored label, so two spellings of one cluster are two
    // bets in the readout and one in the operator's head — which the collector
    // refuses as `config_invalid` for the whole asset. Naming the field here is
    // what lets `clusterSpellingRefusal` catch it where it is typed instead.
    clusterField: 'label',
    // The ONE list in this map with no empty state. `queries: []` is a
    // validation failure for that asset's run (config/serp-panel.README.md: "An
    // empty panel is a mistake worth seeing"), while an asset absent from the
    // file is skipped silently and is the common, valid state — so absence is
    // how "buys no panel" is said, and the last term out takes the whole entry
    // with it. The GA4 lists beside it are the opposite: an entry declaring
    // nothing is a legitimate thing to write down, so they keep their `[]`.
    emptyIsAbsent: true,
    label: 'Tracked queries',
    describe: 'one tracked term, and the bet it measures',
    owner: 'config/serp-panel.README.md',
    surface: "the site's Growth tab",
    fields: [
      {
        name: 'query',
        label: 'Query',
        type: 'string',
        required: true,
        maxLength: 120,
        describe: 'verbatim, as a searcher types it',
      },
      {
        name: 'label',
        label: 'Bet',
        type: 'string',
        required: false,
        maxLength: 60,
        // The clusters this panel already uses are worth OFFERING and wrong to
        // require (bead `ro-g318`): naming a new bet is a legitimate and common
        // edit, and `config/serp-panel.README.md` calls the datalist of labels
        // in use "the friendlier fix" for exactly the near-miss `clusterField`
        // above refuses. So the page may pass values here without any of them
        // becoming a rule.
        candidates: 'suggest',
        // The spelling rule is not a sentence under the input: the picker
        // offers the bets already in use, and `clusterSpellingRefusal` refuses
        // a near miss beside the field (bead `ro-ujb9.96.6.17`).
        describe: 'the bet this term counts toward',
      },
    ],
  },
  'signal-panels': {
    file: 'config/signal-panels.json',
    container: '/assets',
    shape: 'object',
    keyRule: 'asset-id',
    keyField: null,
    label: 'Panel refresh roster',
    describe: 'whether a site stays on the standing panel-refresh cadence',
    owner: 'config/signal-panels.README.md',
    surface: "the site's Growth tab",
    assetRegister: true,
    // A rule about a ROW that no field of it can express, because the fact it
    // turns on lives in ANOTHER file (bead `ro-uko8`). Declared here so both
    // readers find it where they find everything else about this register; the
    // rule itself is `liveSearchLaneRefusal` below, and the lane statuses it
    // judges are supplied by whoever holds them — the Growth tab from the
    // asset's payload, the apply pipeline from config/integrations.json.
    requiresLiveSearchLane: true,
    // CHANGING THE DECISION MOVES THE DECISION'S DATE (bead `ro-6kd6`).
    // `since` is defined below as "when the decision was taken", and the Growth
    // tab edits `enabled` and `since` as independent cells — so flipping the
    // switch and leaving the date alone stamped the NEW decision with the OLD
    // one's day, and `since` is the only audit trail this file carries for a
    // roster change. Declared rather than written into the surface because a
    // hand-written changeset and a deployed Save go through the pipeline too.
    stamps: [{ when: 'enabled', field: 'since' }],
    fields: [
      {
        name: 'enabled',
        // Plain words for the roster (bead `ro-ujb9.135`): whether this site's
        // panel is rebuilt each day. The file keeps `enabled`.
        label: 'Daily refresh',
        type: 'boolean',
        required: true,
        describe: 'rebuilt daily at no provider cost',
      },
      {
        name: 'reason',
        label: 'Reason',
        type: 'enum',
        required: true,
        values: ['live-lanes', 'no-lane-yet', 'not-applicable'],
        valueLabels: {
          'live-lanes': 'Search source live',
          'no-lane-yet': 'No search source yet',
          'not-applicable': "Doesn't apply",
        },
        describe: 'why it is on or off',
      },
      // THE DECISION IS STRUCTURED, NOT A SENTENCE (bead `ro-ujb9.96.6.17`).
      // A free-text `note` used to carry it: which search sources were live
      // and since when (the asset's own Sources tab states that, from
      // config/integrations.json), what would enable an off row (`reason` says
      // it: `no-lane-yet` turns on when a search source is live, and
      // `liveSearchLaneRefusal` refuses it before then) and the task tracking
      // that — the one fact nothing else held, so it is its own field. A
      // stored row that still carries a `note` keeps it on disk; nothing
      // renders it, and a whole-row write drops it (`storedRow` keeps declared
      // fields only).
      {
        name: 'task',
        label: 'Task',
        type: 'string',
        required: false,
        maxLength: 40,
        pattern: '^[a-z]{2,8}-[a-z0-9]+(?:\\.[0-9]+)*$',
        describe: 'the task tracking this decision: ro-2zk.2',
      },
      { name: 'since', label: 'Since', type: 'date', required: false, describe: 'when the decision was taken, YYYY-MM-DD' },
    ],
  },

  // ── the two Settings registers (ro-x5gu.5, ro-x5gu.6) ─────────────────────
  'task-hub-spokes': {
    file: 'config/beads.json',
    container: '/spokes',
    shape: 'array',
    keyField: 'asset',
    // One asset, one prefix, one database. The key field already pins the first;
    // the other two are uniqueness the pointer cannot express and the file would
    // happily hold twice — two projects sharing a prefix make every bead id
    // ambiguous, and two sharing a database merge two backlogs into one board.
    unique: ['prefix', 'database'],
    label: 'Task projects',
    // Adding a row here does NOT create the Dolt database it names: that is an
    // operator step, and the surface says so rather than pretending otherwise.
    // The operator's words, not the tool's: this text is a column heading and a
    // section line on /settings, and `bead` is `bd`'s own coinage (docs/17).
    // What a row IS; its columns (asset, prefix, database) are the map, so the
    // line does not restate them (bead `ro-ujb9.96.6.17`).
    describe: 'one task project per site',
    owner: 'config/beads.README.md',
    surface: '/settings',
    fields: [
      { name: 'asset', label: 'Site', type: 'asset-id', required: true, describe: 'the site this project belongs to' },
      {
        name: 'prefix',
        label: 'Task prefix',
        type: 'string',
        required: true,
        maxLength: 8,
        pattern: '^[a-z]{2,8}$',
        describe: '2–8 lowercase letters, e.g. demo',
      },
      {
        name: 'database',
        label: 'Database',
        type: 'string',
        required: true,
        maxLength: 32,
        pattern: '^[a-z][a-z0-9_]*$',
        // Equal to the prefix for every project so far, and `bd` derives it from
        // the prefix unless told otherwise — so an Add form types it once, into
        // the prefix, and this follows until somebody types something else.
        defaultFrom: 'prefix',
        // Creating the database is an operator step this write does not take;
        // /settings shows it as the project's state (the reconciler's missing
        // database mark and the setup steps after an Add), not as a clause here.
        describe: 'start with a lowercase letter; use lowercase letters, digits or underscores',
      },
      { name: 'repo', label: 'Repository', type: 'string', required: false, maxLength: 200,
        readOnly: true, readOnlyReason: 'Repository access is linked on the machine running the local service.',
        describe: 'legacy checkout metadata; local repository access is configured on the host' },
    ],
  },

  // THE PRODUCT'S DATA-SOURCE CATALOG, NOT A SETTING (bead `ro-ujb9.96.14`).
  //
  // Every field ships with the code: a row only works if the ingest worker has
  // a collector for its `id`, and `scope`, `layer` and `credential` describe
  // how THAT collector behaves — editing one changes how Integrations and
  // Health read a failure without changing anything that collects. So no
  // field is settable (each is `readOnly`, refused by the write lane too) and
  // no screen edits the table. The register stays declared for one reason: a
  // product update that adds or retires a source reaches an existing
  // installation as a changeset — one catalog row inserted with each site's
  // cell beside it (installation/changesets/0008 did PostHog that way), or a
  // row removed — and inserts and deletes are licensed by a register row.
  // The per-field decision is recorded in config/integrations.README.md.
  'data-source-catalog': {
    file: 'config/integrations.json',
    container: '/catalog',
    shape: 'array',
    keyField: 'id',
    label: 'Data-source catalog',
    describe: 'one data source the product can collect',
    owner: 'config/integrations.README.md',
    surface: 'none — it ships with NoticeOS and changes with a product update',
    fields: [
      {
        name: 'id',
        label: 'Id',
        type: 'string',
        required: true,
        maxLength: 40,
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        describe: 'lowercase-with-dashes: bing-webmaster',
        // Every site entry in this file and every collector in the ingest
        // worker names this data source by this id.
        readOnly: true,
      },
      { name: 'label', label: 'Label', type: 'string', required: true, maxLength: 80, describe: 'what the product calls it', readOnly: true },
      {
        name: 'scope',
        label: 'Scope',
        type: 'enum',
        required: true,
        values: ['property', 'portfolio', 'both'],
        describe: 'whether it collects for a site, for the OS, or both',
        readOnly: true,
      },
      {
        name: 'layer',
        label: 'Layer',
        type: 'enum',
        required: true,
        values: ['os', 'provider', 'property'],
        // A red row in one layer explains the red rows under it: methodology
        // (config/integrations.README.md), not a hint under an input.
        describe: 'whose failure a red cell reports',
        readOnly: true,
      },
      {
        name: 'credential',
        label: 'Credential',
        type: 'enum',
        required: true,
        values: ['shared', 'per-property'],
        describe: 'whether one credential can serve more than one site',
        readOnly: true,
      },
      // No prose fields (bead `ro-ujb9.96.6.20`): `liveMeans`, `credentialNote`
      // and `perProperty` were paragraphs nothing renders since
      // `ro-ujb9.96.6.1`. A stored copy that still carries them drops them
      // with a `file-json-delete` licensed by `RETIRED_KEYS`
      // (`config-documents.mjs`), never by declaring them here again.
      { name: 'docRef', label: 'Doc', type: 'string', required: true, maxLength: 200, describe: 'the doc section that explains it', readOnly: true },
    ],
  },

  // ── the portfolio ENTITY register /settings edits (bead `ro-aodz`) ─────────
  //
  // WHICH LEGAL ENTITY OWNS AN ASSET, in one place. It was the first sentence of
  // the ad-network source's note in config/integrations.json — where D5 makes it
  // matter, and where nobody asking "who owns this asset" would ever look. The
  // other honest home was a column on `assets`, which is a migration (AGENTS.md:
  // operator-only) for a fact that moves on a lawyer's schedule rather than the
  // store's. The operator chose this on 2026-09-05.
  //
  // THE EDGE IS STORED ONCE, ON THE ENTITY. An entity owns a list of assets;
  // an asset's owner is read back out of those lists. Storing it on both sides
  // would be two representations of one fact that can disagree — and the asset
  // side has no register of its own to hold it, because config/integrations.json
  // `/assets` is opaque by design (the wizard composes a whole entry).
  //
  // `assets` IS OPTIONAL, and both of its empty states are real: an entity
  // declared before it owns anything has no key at all, and one whose last asset
  // moved away holds `[]`. Neither is a config error, so unlike the tracked-query
  // panel this register declares no `emptyIsAbsent`.
  //
  // AN ASSET BELONGS TO AT MOST ONE ENTITY, and no field of one row can see
  // another — the same shape as `duplicateKey`, one level down. The surfaces
  // that write it enforce it with the facts they hold: /settings refuses a list
  // claiming an asset another row already claims, and the asset's own Identity
  // card moves it in ONE change that takes it off the old list and puts it on
  // the new one.
  entities: {
    file: 'config/entities.json',
    container: '/entities',
    shape: 'array',
    keyField: 'slug',
    label: 'Entities',
    describe: 'one legal entity, and the sites it owns',
    owner: 'config/entities.README.md',
    surface: '/settings',
    fields: [
      {
        name: 'slug',
        label: 'Id',
        type: 'string',
        required: true,
        maxLength: 40,
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        describe: 'lowercase-with-dashes: acme-holdings',
        // FIXED ONCE ADDED: an entity is a legal person, and this is the id
        // every record already written down names it by — a rename would
        // re-label history rather than correct it. A change of NAME is the
        // Name column beside it, and a genuinely different legal person is a
        // new row the assets move to.
        readOnly: true,
      },
      {
        name: 'name',
        label: 'Name',
        type: 'string',
        required: true,
        maxLength: 80,
        describe: 'as on its paperwork',
      },
      {
        name: 'form',
        label: 'Legal form',
        type: 'string',
        required: false,
        maxLength: 40,
        // Deliberately not an enum: legal forms differ by country, and an
        // allowlist written from one jurisdiction refuses a self-hoster's real
        // answer. Blank is a real state — an entity whose paperwork is pending —
        // and the Add form marks the field optional, so no clause says so.
        describe: 'as the paperwork spells it: LLC, Ltd, sole proprietor',
      },
      {
        name: 'jurisdiction',
        label: 'Registered in',
        type: 'string',
        required: false,
        maxLength: 40,
        describe: 'where it is registered: US-DE, Poland',
      },
      {
        name: 'assets',
        label: 'Sites',
        type: 'string-list',
        required: false,
        // The one place that fact is written down (see the comment above).
        describe: 'the site ids this entity owns',
      },
    ],
  },
};

/** When a save here reaches the collectors, as a code the card draws as a
 * chip (bead `ro-ujb9.96.6.4`): `next-run` when this deployment read the
 * document from the store (every collector run re-reads it), `after-restart`
 * when it is still on the copy compiled in (a hand-edited file reaches the
 * collectors on the next restart or deploy; saving here puts the document in
 * the store, and every run after that reads it). */
export type LaneMappingTiming = 'next-run' | 'after-restart';

/** The one true answer, given where this deployment read the file.
 * `source` is `'store'` or `'file'`, straight off `GET /api/config`. */
export function laneMappingTiming(source: 'store' | 'file' | undefined): LaneMappingTiming {
  return source === 'store' ? 'next-run' : 'after-restart';
}

/** The chip for each timing — a state, not the sentence above. */
export const LANE_MAPPING_TIMING_LABEL: Readonly<Record<LaneMappingTiming, string>> = {
  'next-run': 'Applies on the next run',
  'after-restart': 'Applies after a restart',
};

/** The chip for each fallback, beside a lane nothing is mapped on. A mapped
 * lane wears `LANE_MAPPED_LABEL` instead. */
export const LANE_FALLBACK_LABEL: Readonly<Record<LaneFallback, string>> = {
  'google-account-map': 'Using the Google account map',
  'domain-match': 'Matching the site’s domain',
  'portfolio-market': 'Using the US · English default',
  none: 'Not collected until mapped',
};

export const LANE_MAPPED_LABEL: string = 'Mapped here';

/**
 * WHICH MAPPING FIELDS EACH LANE HAS, and WHO READS THEM (bead `ro-vu8d.4`).
 *
 * `asset-lane` declares eight fields because eight is what a lane cell may
 * hold; no lane holds all eight. GA4 maps to a property id, Search Console and
 * Bing to a site, DataForSEO to a location + language. This is that table, and
 * it lives beside the declaration rather than in the Tower so the fields a card
 * renders and the fields the write lane judges cannot drift apart.
 *
 * TWO HONEST STATES, and the card shows whichever is true of THIS asset (beads
 * `ro-vu8d.16`, `ro-ujb9.96.6.4`): "Mapped here" — the collector asks for the
 * value in these fields — or the lane's `fallback`, named per lane in
 * `LaneFallback`. Saving a mapping still does NOT reach into a provider — it
 * steers what the OS asks for, never what the provider holds.
 *
 * WHEN A SAVE TAKES EFFECT IS NOT ONE ANSWER (beads `ro-syok.7`, `ro-7xv2`).
 * Both Workers read the stored document when there is one and the compiled
 * copy when there is not, so `laneMappingTiming` takes the file's entry in
 * `GET /api/config`'s `sources` — the same field the page was built from — and
 * the chip and the behaviour cannot drift.
 */
export const LANE_MAPPING: Record<string, LaneMapping | undefined> = {
  ga4: { fields: ['propertyId'], fallback: 'google-account-map' },
  gsc: { fields: ['siteUrl'], fallback: 'google-account-map' },
  'bing-webmaster': { fields: ['siteUrl'], fallback: 'domain-match' },
  // A field left empty takes the baseline, so either one is this asset's own.
  dataforseo: { fields: ['locationCode', 'languageCode'], fallback: 'portfolio-market' },
  posthog: {
    fields: ['host', 'projectId'],
    // Saved as one list value beside the two fields above, and optional: an
    // asset with no funnels still archives the other five families. PostHog
    // only reads: nothing here creates or changes anything in PostHog.
    lists: ['funnels'],
    fallback: 'none',
  },
};

export const OPERATOR_LANE_STATES: readonly string[] = ['needs-setup', 'skipped'];

/**
 * A DATE A FILE STATES ABOUT ITSELF, AND WHO KEEPS IT TRUE (bead `ro-auav`).
 *
 * Two config files carry a top-level `updated` beside their `version` — the
 * file's own claim about when it last changed. Nothing READS it,
 * which is exactly why it went stale the moment the Tower could write: the
 * add-asset wizard files a roster row, an asset's Sources tab records a posture,
 * and both left the file naming a date before the change. A file that states a
 * fact about itself and is allowed to state it falsely is the same class of
 * defect as a timeline that stops without saying it stopped.
 *
 * SO THE WRITE KEEPS IT. Declared here, once per file that carries one, and
 * applied by `applyDocumentOps` for every entry point at once — the terminal,
 * the dev write lane and the ingest Worker — because a stamp only one of the
 * three made would be a third answer to "when did this file last change".
 *
 * IT REFRESHES, IT NEVER INVENTS. A document that carries no such pointer gains
 * nothing: "we never create structure" is the oldest rule in this pipeline, and a
 * file that has never claimed a date is not lying about one.
 */
export const DOCUMENT_STAMPS: Readonly<Record<string, string>> = {
  'config/integrations.json': '/updated',
  'config/signal-panels.json': '/updated',
};

/** The pointer a write refreshes in this file, or `null`. */
export function documentStamp(file: string): string | null {
  return DOCUMENT_STAMPS[file] ?? null;
}

/**
 * THE DATES A ROW MOVES WHEN A DECISION MOVES (bead `ro-6kd6`).
 *
 * A register may declare `stamps: [{ when, field }]` — "when a write CHANGES the
 * `when` field of a row, set that row's `field` to the day it was applied". The
 * roster's `since` is the case it was built for: it means *when the decision was
 * taken*, and `enabled` is the decision, so the two were one fact edited as two
 * independent cells and a flip left the row claiming a day it was not decided on.
 *
 * It is a rule of the PIPELINE rather than a second op the browser sends, so the
 * date follows the write wherever the write comes from — a Save, `pnpm
 * config:apply`, or the deployed door — and CollectionEditor's one-changeset-
 * per-cell contract is untouched.
 *
 * `[]` for a register that declares none, which is all of them but one.
 */
export function registerStamps(register: ConfigRegister): readonly RegisterStamp[] {
  return register.stamps ?? [];
}

/**
 * THE SCALAR KNOBS, declared one pointer at a time (bead `ro-x5gu.8`).
 *
 * A register licenses a LIST — its rows, and the declared fields inside them.
 * Beside those lists sit plain numbers that are every bit as much settings, in
 * files that are deliberately NOT wholesale-editable: `config/signal-panels.json`'s
 * `/refresh` pair. Until this declaration they were reachable from nowhere at
 * all, and `/settings` rendered them as rows pointing at their file because a
 * Save would have been refused.
 *
 * `config/counters.json` `intervalMinutes` was the third, and is retired (bead
 * `ro-ujb9.222`): how often the counter cards are read is the counters job's
 * schedule (`scripts/scheduled-jobs.mts`, changed in Settings → Data
 * collection), and the Tower ages the cards against that schedule.
 *
 * WIDENING `SETTABLE_FILES` WOULD HAVE BEEN THE WRONG FIX. Putting
 * `config/signal-panels.json` there licenses rewriting every roster note. No
 * surface asks for that. So this is the narrow option: one entry per
 * scalar POINTER, carrying the same `RegisterField` a register's column carries
 * — so `fieldRefusal` judges it with the identical sentence — and licensing
 * `file-json-set` at that exact pointer and nowhere else. One level up
 * (`/refresh`) is refused, and so is one level down.
 *
 * ONE DECLARATION, TWO READERS, exactly as with the registers: the core
 * licenses the set from these lines, and the Tower's `KnobEditor` row reads the
 * same label and the same rule from them.
 *
 * WHAT CHANGING ONE COSTS IS DRAWN, NOT WRITTEN (beads `ro-ujb9.96.6.3`,
 * `ro-ujb9.96.6.17`). A cadence knob with no visible cost is an invitation to
 * make the OS read more often and find out afterwards what that bought — so
 * /settings puts the cost beside the field as a value (`collectionVisual`:
 * the price per pass, the freshness bar's fit inside the window). The
 * `consequence` paragraphs that used to live here were rendered by nothing
 * once that shipped; what each knob costs is in the comment above it.
 *
 * DELIBERATELY NOT DECLARED: `config/beads.json` `/hub` (host, port, dataDir).
 * That is how `bd` reaches the Dolt server on this machine — wiring rather than
 * a portfolio setting, and nothing a browser should be able to move.
 */
export const CONFIG_KNOBS: Record<ConfigKnobKey, ConfigKnob> = {
  // A performance bound, not a correctness one: history outside the window
  // stays on disk and in the downloads manifest. A refresh pass makes zero
  // provider calls, so widening it buys more history for $0.00 of metered spend
  // (drawn beside the field). It must stay at or above the freshness bar.
  'panel-refresh-window': {
    file: 'config/signal-panels.json',
    pointer: '/refresh/windowDays',
    label: 'Panel history window',
    unit: 'Days',
    owner: 'config/signal-panels.README.md',
    surface: '/settings',
    field: {
      name: 'windowDays',
      label: 'Panel history window',
      type: 'integer',
      required: true,
      min: 1,
      max: 365,
      describe: 'days of history each refresh reads',
    },
  },
  // Every asset regrades itself against the new bar on the next pass — a
  // stricter bar reports sources stale that were fresh a moment ago without
  // anything about the data changing. The history window has to cover it, or
  // a source can never be graded fresh (drawn beside the field as a ✓/✕ fit).
  'panel-freshness-bar': {
    file: 'config/signal-panels.json',
    pointer: '/refresh/freshnessMaxAgeDays',
    label: 'Panel freshness bar',
    unit: 'Days',
    owner: 'config/signal-panels.README.md',
    surface: '/settings',
    field: {
      name: 'freshnessMaxAgeDays',
      label: 'Panel freshness bar',
      type: 'integer',
      required: true,
      min: 1,
      max: 365,
      describe: 'how old a source may get before it reads stale',
    },
  },
};

/**
 * The files a `file-json-set` may edit at ANY pointer — the original safety
 * allowlist, unchanged in meaning since it was written.
 *
 * It is deliberately NOT "every file with a register": a register licenses its
 * own declared fields and nothing else, while these four are wholesale editable
 * because their whole contents are settings the Tower renders as knobs.
 * `config/integrations.json` is in both lists, which is how an asset's lane
 * status is still written while its catalog rows are field-validated.
 */
export const SETTABLE_FILES: readonly string[] = [
  'config/constants.json',
  'config/pull.json',
  'config/integrations.json',
  'config/tower.json',
];

// ── derived views ───────────────────────────────────────────────────────────

/** `[key, register]` for every declaration, in file order. */
export function registerEntries(): [ConfigRegisterKey, ConfigRegister][] {
  return Object.entries(CONFIG_REGISTERS) as [ConfigRegisterKey, ConfigRegister][];
}

/** Every register declared for one file, in declaration order. */
export function registersForFile(file: string): [ConfigRegisterKey, ConfigRegister][] {
  return registerEntries().filter(([, r]) => r.file === file);
}

/** Every file any register names — the add/remove boundary. */
export function registerFiles(): string[] {
  return [...new Set(registerEntries().map(([, r]) => r.file))];
}

/** `[key, knob]` for every scalar knob, in declaration order. */
export function knobEntries(): [ConfigKnobKey, ConfigKnob][] {
  return Object.entries(CONFIG_KNOBS) as [ConfigKnobKey, ConfigKnob][];
}

/** Every knob declared for one file, in declaration order. */
export function knobsForFile(file: string): [ConfigKnobKey, ConfigKnob][] {
  return knobEntries().filter(([, k]) => k.file === file);
}

/**
 * The knob a pointer IS, or null.
 *
 * An exact match and nothing else — no prefix, no parent, no child. That is the
 * whole permission: `/refresh/windowDays` is settable, `/refresh` is not, and
 * neither is anything below either of them.
 */
export function matchKnob(file: string, pointer: string): KnobMatch | null {
  if (typeof pointer !== 'string') return null;
  for (const [key, knob] of knobsForFile(file)) {
    if (knob.pointer === pointer) return { key, knob };
  }
  return null;
}

/** Escape a literal for embedding in a RegExp source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The container pointer with `{asset}` filled in. Throws when a per-asset
 * register is asked for a container without one. */
export function resolveContainer(register: ConfigRegister, params: { asset?: string } = {}): string {
  if (!register.container.includes(ASSET_PARAM)) return register.container;
  const asset = params.asset;
  if (typeof asset !== 'string' || !new RegExp(`^${ASSET_ID_SOURCE}$`).test(asset)) {
    throw new Error(`register container ${register.container} needs a site id, got ${JSON.stringify(asset)}`);
  }
  return register.container.split(ASSET_PARAM).join(asset);
}

/** A RegExp matching this register's container at the START of a pointer, with
 * the asset (when the register has one) as capture group 1. */
export function containerRegExp(register: ConfigRegister): RegExp {
  const source = register.container
    .split(ASSET_PARAM)
    .map(escapeRegExp)
    .join(`(${ASSET_ID_SOURCE})`);
  return new RegExp(`^${source}(?=/|$)`);
}

/**
 * Which register (if any) owns a pointer in a file, and what is left of the
 * pointer past its container.
 *
 * `rest` is the remaining reference tokens: `[]` for the container itself,
 * `['3']` for a row, `['3','domain']` for one field of a row. `params` carries
 * the asset a per-asset container matched.
 */
export function matchRegister(file: string, pointer: string): RegisterMatch | null {
  if (typeof pointer !== 'string') return null;
  let best: RegisterMatch | null = null;
  for (const [key, register] of registersForFile(file)) {
    const m = containerRegExp(register).exec(pointer);
    if (m === null) continue;
    // LONGEST container wins, never declaration order. Several files hold a
    // whole-asset register at `/assets` AND a list inside each asset
    // (`/assets/<asset>/queries`), and a pointer inside the list belongs to the
    // list — a shorter container that also matches is the holder, which knows
    // nothing about the fields below it.
    if (best === null || m[0].length > best.container.length) {
      const tail = pointer.slice(m[0].length);
      best = {
        key,
        register,
        rest: tail === '' ? [] : tail.slice(1).split('/'),
        params: m[1] === undefined ? {} : { asset: m[1] },
        container: m[0],
      };
    }
  }
  return best;
}

/**
 * The register that files this per-asset list's HOLDER entry, and the key the
 * list lives at inside it — or `null` for a register that needs no holder.
 *
 * A pointer never creates structure, and `/assets/<asset>/valueEvents` cannot be
 * appended to until `/assets/<asset>` exists. An asset with NO entry is the
 * common case in every one of these files (absence is "not declared", by
 * design), so a surface adding the FIRST row has to file the whole entry
 * instead: `{ valueEvents: [row] }` at `/assets/<asset>`. That stays one op and
 * one changeset, and one delete at the same pointer reverses it exactly.
 *
 * It is DERIVED, never declared twice: a per-asset list's container is always
 * `<holder container>/{asset}/<field>`, so the holder is the object register in
 * the same file whose container is that prefix. A register pair therefore
 * cannot drift, and a new pair needs nothing here.
 */
export function holderOf(register: ConfigRegister): RegisterHolder | null {
  const parts = register.container.split(`/${ASSET_PARAM}/`);
  if (parts.length !== 2 || parts[1] === '' || parts[1]!.includes('/')) return null;
  const [container, field] = parts as [string, string];
  for (const [key, holder] of registersForFile(register.file)) {
    if (holder.container === container && holder.shape === 'object') {
      return { key, register: holder, field };
    }
  }
  return null;
}

/** The one field declaration a name resolves to, or null. */
export function fieldOf(register: ConfigRegister, name: string): RegisterField | null {
  return register.fields?.find((f) => f.name === name) ?? null;
}

/** What an object register's key must look like, by `keyRule`. */
const KEY_RULE_SOURCE: Readonly<Record<string, string>> = { 'asset-id': ASSET_ID_SOURCE, 'lane-id': LANE_ID_SOURCE };

/** Is this reference token a legal ROW address in this register's container? */
export function isRowToken(register: ConfigRegister, token: string): boolean {
  if (register.shape === 'array') return /^\d+$/.test(token);
  const source = KEY_RULE_SOURCE[register.keyRule as string] ?? ASSET_ID_SOURCE;
  return new RegExp(`^${source}$`).test(token);
}

/**
 * MAY AN INSERT INTO THIS ARRAY NAME A POSITION? (bead `ro-asj9`)
 *
 * A delete SPLICES a row out, so an undo that could only append returned it at
 * the END of the list — the row came back, its neighbours' order did not, which
 * is visible wherever the table is drawn in file order (/financials is). An
 * indexed insert is what RFC 6902's `add` has always meant for an array, and it
 * is what makes an undo an undo.
 *
 * Every array register whose rows have DECLARED FIELDS may name one. The one
 * that may not is the only opaque array in this map, `config/pull.json`: its
 * rows are whole asset endpoints the wizard files and unfiles, nothing reads
 * their position, and an index there would be a claim about nothing. Derived
 * rather than declared a second time, because those are the same fact — a
 * register whose rows are opaque is one nothing addresses INSIDE.
 *
 * The guard is not weakened. An insert has never carried an `expect` (its guard
 * is fixed at "nothing is there yet"), so the position an append landed at was
 * never checked either; what is new is that an index past the end of the list is
 * refused loudly instead of quietly appending as if it had said `-`.
 */
export function positionedInsert(register: ConfigRegister): boolean {
  return register.shape === 'array' && register.fields !== null;
}

/** How a refusal spells where an entry may be added / removed. Quoting follows
 * the shape: an array append is a literal token and reads as one. */
export function legalRowPointer(register: ConfigRegister, kind: string): string {
  const container = register.container.split(ASSET_PARAM).join('<asset-id>');
  if (register.shape === 'object') return `${container}/<${register.keyRule ?? 'asset-id'}>`;
  if (kind === 'file-json-insert') {
    const append = JSON.stringify(`${container}/-`);
    return positionedInsert(register) ? `${append} or ${container}/<index>` : append;
  }
  return `${container}/<index>`;
}

// ── field validation, the one place a row's shape is decided ────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** A calendar date that exists (2026-02-30 parses and is not a date). */
function realDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The name a person reads for a field: its label ("Site", "Panel freshness
 * bar"), or its key only where a declaration carries no label (bead
 * `ro-ujb9.154`; D31, doc 14 rule 8 — never a code key on screen). */
function fieldLabel(field: Pick<RegisterField, 'name' | 'label'>): string {
  return typeof field.label === 'string' && field.label.trim() !== '' ? field.label : field.name;
}

/**
 * Check one value against one field declaration.
 *
 * Returns `null` when it is fine, or the RULE it broke as a sentence that
 * names the field by its label — the same sentence the CLI prints, the lane
 * returns in a 422 and the Tower shows under the input, because a refusal an
 * operator reads twice in two wordings is two refusals.
 */
export function fieldRefusal(field: RegisterField, value: unknown): string | null {
  const label = fieldLabel(field);
  if (value === undefined || value === null) {
    return field.required ? `${label} is required` : null;
  }
  switch (field.type) {
    case 'string':
    case 'url':
    case 'date':
    case 'month':
    case 'asset-id':
    case 'store-asset-id':
    case 'domain':
    case 'enum': {
      if (typeof value !== 'string') return `${label} must be a string`;
      if (value.trim() === '') {
        return field.required ? `${label} is required` : `${label} must not be blank`;
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `${label} must be ${field.maxLength} characters or fewer`;
      }
      if (field.type === 'enum' && !field.values!.includes(value)) {
        return `${label} must be one of ${field.values!.join(' | ')}`;
      }
      if (field.type === 'date' && !realDate(value)) return `${label} must be a date, YYYY-MM-DD`;
      if (field.type === 'month' && !MONTH_RE.test(value)) return `${label} must be a month, YYYY-MM`;
      if (field.type === 'asset-id' && !new RegExp(`^${ASSET_ID_SOURCE}$`).test(value)) {
        return `${label} must be a site id`;
      }
      if (field.type === 'store-asset-id' && !ASSET_ID_RE.test(value)) return `${label} must be a site id`;
      if (field.type === 'domain' && !DOMAIN_RE.test(value)) {
        return `${label} must be a hostname such as example.com`;
      }
      if (field.type === 'url' && !/^https?:\/\/\S+$/.test(value)) {
        return `${label} must be an http or https URL`;
      }
      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
        return `${label}: ${field.describe}`;
      }
      return null;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number`;
      if (field.type === 'integer' && !Number.isInteger(value)) return `${label} must be a whole number`;
      if (field.min !== undefined && value < field.min) return `${label} must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `${label} must be at most ${field.max}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${label} must be true or false`;
    case 'posthog-funnels':
      // The one structured field (bead ro-ghis.1). Its rule lives in the
      // portable contract so the collector refuses exactly what this refuses.
      return posthogFunnelsRefusal(value, label);
    case 'string-list': {
      if (!Array.isArray(value)) return `${label} must be a list of strings`;
      if (value.some((v) => typeof v !== 'string' || v.trim() === '')) {
        return `${label} must be a list of non-blank strings`;
      }
      return null;
    }
    default:
      return `${label} has an unknown field type ${JSON.stringify(field.type)}`;
  }
}

/** The fields of a site's row in the store. */
export type SiteRowField = 'id' | 'displayName' | 'domain' | 'status' | 'senseOnly';

/**
 * A SITE'S ROW IN THE STORE (the `assets` table), field by field, as the
 * ingest's site lanes check it — Add a site's create, the Settings tab's column
 * writes, the empty-site delete, and every lane that names a site in its body
 * (`workers/ingest/src/routes/validate.ts` `declaredString`, bead
 * `ro-ujb9.183`).
 *
 * Not a register: the row lives in the store, not in a file, and nothing here
 * licenses a write. It is declared as fields so that its refusals are worded by
 * `fieldRefusal`, like every register's — "Domain must be a hostname such as
 * example.com", "Site must be a site id" — and never by the key a request body
 * carries or the retired noun "property" (D31). The labels are the ones beside
 * the Tower's inputs (Add a site's Domain; the Settings tab's Display name and
 * Automation).
 */
export const SITE_ROW_FIELDS: Readonly<Record<SiteRowField, RegisterField>> = {
  id: {
    name: 'id',
    label: 'Site',
    type: 'store-asset-id',
    required: true,
    maxLength: ASSET_ID_MAX,
    describe: 'a domain or a short slug: example.com',
  },
  displayName: {
    name: 'displayName',
    label: 'Display name',
    type: 'string',
    required: true,
    maxLength: DISPLAY_NAME_MAX,
    describe: 'the name the desk shows',
  },
  domain: {
    name: 'domain',
    label: 'Domain',
    type: 'domain',
    required: false,
    maxLength: 253,
    describe: 'lowercase, a name not a URL: example.com',
  },
  status: {
    name: 'status',
    label: 'Lifecycle stage',
    type: 'enum',
    required: false,
    values: ASSET_STATUSES,
    describe: 'pre-launch, onboarding, baselining, live or retired',
  },
  senseOnly: {
    name: 'senseOnly',
    label: 'Automation',
    type: 'integer',
    required: false,
    min: 0,
    max: 1,
    describe: '1 monitors only, 0 may act',
  },
};

/**
 * A refusal and the field it is about (bead `ro-ujb9.184`): `field` is the
 * declared field's `name` whose rule broke, or null when the refusal is the
 * row's or the list's as a whole (not an object, an undeclared key, no room).
 * The Add form outlines that one input and no other; the lane and the CLI read
 * only `message`, through `rowRefusal` and `duplicateKey`.
 */
export interface RowIssue {
  field: string | null;
  message: string;
}

/**
 * Check a whole ROW against a register.
 *
 * A scalar register (a string list, a tracked query with no cluster) accepts the
 * bare value as well as the one-field object; everything else must be an object,
 * every required field present, and NO undeclared key — an unknown key is a
 * typo that would land in a config file nobody validates again.
 */
export function rowIssue(register: ConfigRegister, value: unknown): RowIssue | null {
  const whole = (message: string): RowIssue => ({ field: null, message });
  const at = (field: RegisterField, message: string | null): RowIssue | null =>
    message === null ? null : { field: field.name, message };
  if (register.fields === null) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return whole('value must be a JSON object (one site\'s entry)');
    }
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const scalar = register.scalarField === undefined ? null : fieldOf(register, register.scalarField);
    if (scalar === null) return whole('value must be a JSON object (one row)');
    return at(scalar, fieldRefusal(scalar, value));
  }
  for (const key of Object.keys(value)) {
    if (fieldOf(register, key) === null) {
      return whole(`${key} is not a field here — this one declares ${register.fields.map((f) => f.name).join(', ')}`);
    }
  }
  for (const field of register.fields) {
    const issue = at(field, fieldRefusal(field, (value as Row)[field.name]));
    if (issue !== null) return issue;
  }
  if (register.shape === 'array' && register.keyField !== null) {
    const key = (value as Row)[register.keyField as string];
    if (key === undefined || key === null || key === '') {
      return { field: register.keyField ?? null, message: `${register.keyField} is required` };
    }
  }
  return null;
}

/** `rowIssue`'s sentence alone — what the lane and the CLI print. */
export function rowRefusal(register: ConfigRegister, value: unknown): string | null {
  return rowIssue(register, value)?.message ?? null;
}

/**
 * A FIELD MAY BE SET WHEN THE ROW IS CREATED AND NOT AFTERWARDS (bead `ro-xhy5`).
 *
 * The declared keys whose rename silently breaks something the table cannot
 * show — the data-source catalog's `id` (every asset entry and every collector
 * names the source by it), a recurring cost's `id` (part of the ledger's
 * idempotency key, so a rename re-books every month already booked), a domain
 * order's `domain` (what the registrar's next export is reconciled against),
 * an entity's `slug` — and one figure, a recurring cost's monthly amount (every
 * booked month was booked at it). Each once carried the warning in a sentence;
 * this is the control that does not offer the edit, and the lock with "Fixed
 * once added" (`fixedFieldLabel`) is all the table says (bead
 * `ro-ujb9.96.6.17`).
 *
 * IT IS A LANE RULE, NOT A UI ONE. A UI-only read-only field is a suggestion: a
 * hand-written changeset would still rename the key, and the pipeline would
 * apply it. So `config-apply-core.mjs` refuses the set too — which also refuses
 * a hand-authored RENAME changeset, and that is the right answer, because a
 * rename needs matching edits in files (and collectors) this pipeline cannot
 * make. The way to change one is the way the money and the code already went:
 * remove the row and record the new one.
 *
 * ADDING IS UNTOUCHED. A new row must set its key, so `blankRow`, the Add form
 * and `file-json-insert` never ask this.
 */
export function readOnlyFieldRefusal(field: RegisterField | null | undefined): string | null {
  if (field === null || field === undefined || field.readOnly !== true) return null;
  const because = field.readOnlyReason === undefined ? '' : ` — ${field.readOnlyReason}`;
  return `${field.name} is set when a row is created and not changed afterwards${because}`;
}

/** The state a fixed field shows beside its lock, in the table and on the Add
 * form: a label, not a rationale. */
export const FIXED_FIELD_LABEL: string = 'Fixed once added';

/** What a read-only field's lock says: its own state where it declares one (a
 * field no surface here writes), otherwise "Fixed once added". `null` for a
 * field that is not read-only. */
export function fixedFieldLabel(field: RegisterField | null | undefined): string | null {
  if (field === null || field === undefined || field.readOnly !== true) return null;
  return field.readOnlyReason ?? FIXED_FIELD_LABEL;
}

/**
 * `readOnlyFieldRefusal` for a whole ROW being replaced at its own pointer.
 *
 * A row is set whole for two honest reasons — a scalar row has nothing below it
 * to address, and clearing an optional field removes the key rather than writing
 * `null` — and neither of them touches a read-only field. So the question is not
 * "is the row settable" but "did this write MOVE a read-only value": an
 * unchanged key rides along, a changed one is the rename above by another
 * pointer. `before` is the op's own `expect`, which is the row as the file held
 * it, so no second read is needed.
 */
export function readOnlyRowRefusal(register: ConfigRegister, before: JsonValue, after: JsonValue): string | null {
  for (const field of register.fields ?? []) {
    if (field.readOnly !== true) continue;
    const was = rowValue(register, before)[field.name];
    const now = rowValue(register, after)[field.name];
    if (was === undefined && now === undefined) continue;
    if (was !== now) return readOnlyFieldRefusal(field);
  }
  return null;
}

/**
 * A value outside the CANDIDATE SET a field's value domain actually has, as the
 * same kind of sentence every other refusal here is (bead `ro-x5gu.10`).
 *
 * `fieldRefusal` can only judge SHAPE, because a declaration cannot know which
 * asset ids this OS holds — those are rows in the store and keys in
 * `config/integrations.json`, neither of which this plain-Node module may read.
 * So the candidates arrive from whoever DOES know: the browser passes the
 * integration matrix's asset list (`CollectionEditor`'s `fieldOptions`), and the
 * apply pipeline passes the roster below. Same function, same sentence, so a
 * typo cannot be refused in one wording upstream and another downstream.
 *
 * AN EMPTY OR ABSENT SET IS "NOBODY ANSWERED", never "nothing is allowed": a
 * page whose own source has not loaded, and a temp repo with no roster file,
 * both refuse nothing rather than refusing everything.
 */
export function candidateRefusal(
  field: RegisterField | null | undefined,
  candidates: readonly string[] | null | undefined,
  value: unknown,
): string | null {
  // AN OPEN DOMAIN'S LIST IS A PICKER, NOT AN ALLOWLIST (bead `ro-g318`). One
  // prop did two jobs — offer the values in use, and refuse everything else —
  // and the coupling is right only where the domain is CLOSED. The tracked-query
  // Bet column is the counter-case: the labels already in use are worth
  // offering, and a NEW cluster is a legitimate, common edit. So the FIELD says
  // which it is, once, where every other rule about it is declared; the page
  // still just hands over the values it knows.
  if (field !== null && field !== undefined && field.candidates === 'suggest') return null;
  if (candidates === undefined || candidates === null || candidates.length === 0) return null;
  if (typeof value !== 'string' || value === '') return null;
  if (candidates.includes(value)) return null;
  const shown = candidates.slice(0, 5).join(', ');
  return `${field!.name} ${JSON.stringify(value)} is not one of ${shown}${candidates.length > 5 ? ', …' : ''}`;
}

/**
 * ONE CLUSTER, ONE SPELLING (bead `ro-cnsj`).
 *
 * `config/serp-panel.README.md`'s rule, and the collector's: grouping is an
 * exact string match on the stored label, so "Item head" and "Item Head" are two
 * bets in the readout and one bet in the operator's head. The collector
 * (`workers/ingest/src/dataforseo-dumps.ts` `trackedLabel`) refuses the asset's
 * WHOLE panel for that run with `config_invalid`, so relabelling one row of a
 * six-row cluster writes a config that fails next Monday rather than one that
 * reads wrong — loud, but a week late and a whole panel wide.
 *
 * This is a rule about the LIST, and the only fact it needs is the list itself,
 * which is why `CollectionEditor` applies it without the page's help: nothing
 * outside the rows decides it.
 *
 * `exceptToken` is the row being edited — its own current spelling is not a
 * clash with itself, so recasing a cluster only ONE row uses is allowed, and
 * that is the honest reading: the collector refuses two spellings coexisting,
 * never a rename. `null` for the Add form, where every row is somebody else's.
 *
 * Only a NEAR MISS is refused. A label that matches an existing one exactly
 * joins that cluster, and a genuinely new label starts a new one — moving a term
 * between bets is a legitimate edit the collector has no opinion about.
 */
export function clusterSpellingRefusal(
  register: ConfigRegister,
  rows: readonly JsonValue[] | null | undefined,
  exceptToken: string | null,
  field: RegisterField,
  value: unknown,
): string | null {
  const cluster = register.clusterField;
  if (cluster === undefined || field.name !== cluster) return null;
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label === '') return null;
  const key = label.toLowerCase();
  const items = rows ?? [];
  for (let index = 0; index < items.length; index += 1) {
    if (String(index) === String(exceptToken)) continue;
    const other = rowValue(register, items[index]!)[cluster];
    if (typeof other !== 'string') continue;
    const spelled = other.trim();
    if (spelled.toLowerCase() === key && spelled !== label) {
      return `spells one cluster two ways: ${JSON.stringify(spelled)} and ${JSON.stringify(label)} — pick one, or the collector refuses the panel`;
    }
  }
  return null;
}

/**
 * The lanes `config/signal-panels.README.md` counts as a SEARCH lane. Its own
 * validation snippet reads exactly these three out of `config/integrations.json`.
 */
export const SEARCH_LANES: readonly string[] = ['gsc', 'ga4', 'bing-webmaster'];

/** One asset's `config/integrations.json` entry as a flat `lane → status` map —
 * the shape `liveSearchLaneRefusal` judges, so the browser (which holds the same
 * facts in the Tower's own richer shape) and the pipeline hand it the same
 * thing. Anything that is not an entry reads as `null`: nobody answered. */
export function laneStatuses(entry: unknown): Record<string, string> | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const statuses: Record<string, string> = {};
  for (const [lane, cell] of Object.entries(entry)) {
    if (cell !== null && typeof cell === 'object' && !Array.isArray(cell) && typeof cell.status === 'string') {
      statuses[lane] = cell.status;
    }
  }
  return statuses;
}

/**
 * TURNING A ROSTER ROW ON IS A CLAIM ABOUT ANOTHER FILE (bead `ro-uko8`).
 *
 * `config/signal-panels.README.md` states the rule — *an asset is `enabled`
 * here when at least one of its `gsc` / `ga4` / `bing-webmaster` lanes is `live`
 * in `config/integrations.json`* — and its own validation snippet fails the
 * roster with the sentence below. Before the Growth tab, the check was a person
 * reading that README beside the file; a click needs the rule itself.
 *
 * WHY IT MATTERS: a refresh pass over an asset with no live lane writes an EMPTY
 * panel dir, and doc 20 says an empty panel dir is indistinguishable on disk
 * from a collapsed one — the exact ambiguity the roster exists to prevent.
 *
 * `statuses` is that asset's lanes as `laneStatuses` returns them. `null` or an
 * empty map is "nobody answered" and refuses nothing, the same reading every
 * other runtime-fact rule here gives an absent answer. Only `enabled: true` is
 * ever refused: turning a row OFF is always allowed, and always should be.
 */
export function liveSearchLaneRefusal(
  field: RegisterField,
  statuses: Record<string, string> | null | undefined,
  value: unknown,
): string | null {
  if (field.name !== 'enabled' || value !== true) return null;
  if (statuses === null || statuses === undefined) return null;
  if (Object.keys(statuses).length === 0) return null;
  if (SEARCH_LANES.some((lane) => statuses[lane] === 'live')) return null;
  // Enabled with no live source, a refresh would write an empty panel.
  return `enabled but no live search source in integrations.json — connect one of ${SEARCH_LANES.join(', ')} first`;
}

/**
 * WHICH REGISTER'S KEYS ARE THE ASSET IDS THIS OS HAS (bead `ro-x5gu.10`).
 *
 * `config/integrations.json` `/assets` carries one entry per asset — the
 * add-asset wizard files it on Create, the Settings tab's Delete removes it, and
 * `config/signal-panels.README.md` makes "the roster's keys equal this file's
 * keys" a stated invariant. It is also exactly the list the Tower's integration
 * matrix filters the store by, which is why the browser and the pipeline end up
 * checking the same names.
 *
 * It is named by register KEY rather than by path so the file and container are
 * still declared once, above.
 */
export const ASSET_ROSTER_REGISTER: ConfigRegisterKey = 'asset-integrations';

/** The roster's own file — what a caller has to read before it can pass
 * candidates. */
export function assetRosterFile(): string {
  return CONFIG_REGISTERS[ASSET_ROSTER_REGISTER].file;
}

/**
 * The asset ids a PARSED roster file declares, or `[]`.
 *
 * `[]` means "this file said nothing" and therefore refuses nothing — the same
 * reading `candidateRefusal` gives an empty list, and the reason a throwaway
 * repo with no `config/integrations.json` still applies its changesets.
 */
export function rosterAssetIds(doc: unknown): string[] {
  const register = CONFIG_REGISTERS[ASSET_ROSTER_REGISTER];
  let cur: unknown = doc;
  for (const token of register.container.slice(1).split('/')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return [];
    cur = (cur as Row)[token];
  }
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return [];
  return Object.keys(cur);
}

/** Every declared field of a register whose value domain is the asset roster —
 * the fields `candidateRefusal` is asked about. */
export function assetIdFields(register: ConfigRegister): RegisterField[] {
  return (register.fields ?? []).filter((f) => f.type === 'asset-id');
}

/**
 * Is a row already using a value that has to be its own? The uniqueness the
 * shapes imply but the pointer cannot express — a duplicate `id` in
 * recurring-costs re-books a month, a duplicate `domain` double-counts an order.
 * Read by the Tower before it sends, so the operator sees it beside the field
 * rather than as a 422.
 *
 * The key field is always one of these. A register may name MORE in `unique`,
 * for the columns that are not the row's identity but still may not repeat — a
 * task-hub project's bead prefix and its database, either of which appearing
 * twice makes two projects indistinguishable downstream.
 */
export function duplicateIssue(
  register: ConfigRegister,
  rows: readonly JsonValue[] | null | undefined,
  value: JsonValue,
): RowIssue | null {
  if (register.shape !== 'array') return null;
  const candidate = rowValue(register, value);
  const names = [...new Set([register.keyField, ...(register.unique ?? [])])];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const key = candidate[name];
    if (key === undefined) continue;
    const clash = (rows ?? []).some((row) => rowValue(register, row)[name] === key);
    // Named by its label, as `fieldRefusal` names a field (bead ro-ujb9.154).
    if (clash) {
      return { field: name, message: `${fieldLabel(fieldOf(register, name) ?? { name, label: '' })} ${JSON.stringify(key)} is already in this list` };
    }
  }
  return null;
}

/** `duplicateIssue`'s sentence alone. */
export function duplicateKey(
  register: ConfigRegister,
  rows: readonly JsonValue[] | null | undefined,
  value: JsonValue,
): string | null {
  return duplicateIssue(register, rows, value)?.message ?? null;
}

/** One stored item as a field map, expanding a scalar item into its one field.
 * The single way a register's rows become table rows. */
export function rowValue(register: ConfigRegister, item: JsonValue): { [key: string]: JsonValue } {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) return item;
  if (register.scalarField === undefined) return {};
  return { [register.scalarField]: item };
}
