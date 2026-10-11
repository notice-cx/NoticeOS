// wall-layout.mts — the Wall's composition as a document, and the one rule for
// "can the Wall draw this". The renderer at `/wall`, the editor at `/wall/edit`
// and every door a layout can be written through share it;
// `apps/tower/shared/wall-layout.ts` is the typed re-export.
//
// Authored TypeScript: `pnpm generate` writes the plain-ESM
// `wall-layout.mjs` and the `wall-layout.d.mts` beside it. No `node:` imports:
// the portable generation project gives this file no Node types.
//
// The layout lives in `config/tower.json` at pointer `/wall`, as a
// `WallConfig`: the current layout plus the versions it replaced, newest first.
// Absent, the Wall is `DEFAULT_WALL_LAYOUT`.
//
// Retired widgets. A layout saved before the current Wall may name widgets it
// no longer has. Reading one is never refused and never blank: the Wall draws
// the default in its place and the editor says so once (`WallConfig.retired`).
// Writing a standalone `/wall/layout` that names one is refused; a whole
// `/wall` write accepts readable retired history so Undo can restore it.
//
// Widths are weights, not columns: a row's widgets share its width in
// proportion to their `width` (the `fr` a CSS grid track takes), because the
// Wall must fit one fixed 1920×1080 screen (`pnpm audit:wall-fit`). A widget also
// carries a floor (`minWidthRem`) below which its content clips; the renderer
// applies it as the track's minimum.
//
// One representation per fact: the countdown's emoji, label and target stay at
// `/countdown`, and the countdown widget's editor panel shows that form
// (`configuredAt`). A widget setting exists here only when the renderer
// applies it.

// From the portable contract module that owns it, not through
// `config-registers.mjs`, which re-exports the same constant: the TV draws this
// module, and importing one string through the registers would download all
// of them to `/wall`.
import { CONFIG_ASSET_KEY_SOURCE as ASSET_ID_SOURCE } from '../packages/contract/src/configuration.mjs';

/** The asset-id rule the rest of config validation already uses. */
const ASSET_ID_RE = new RegExp(`^${ASSET_ID_SOURCE}$`);

export const WALL_LAYOUT_VERSION = 1;

/** JSON pointer inside `config/tower.json` that holds the `WallConfig`. */
export const WALL_LAYOUT_POINTER = '/wall';

/** Versions kept beside the current layout; the oldest falls off. */
export const WALL_LAYOUT_HISTORY_MAX: number = 20;

export const WALL_MAX_ROWS: number = 6;
export const WALL_MAX_WIDGETS_PER_ROW: number = 4;

/** `width` bounds, in grid fractions. A quarter is the narrowest anything on a
 * TV can still be read from across a room; twelve is wider than any row. */
export const WALL_WIDTH_MIN: number = 0.25;
export const WALL_WIDTH_MAX: number = 12;
export const WALL_WIDTH_STEP: number = 0.05;

/** The TV the Wall is fitted to (`scripts/wall-fit-check.mjs`). */
export const WALL_TV_WIDTH: number = 1920;
export const WALL_TV_HEIGHT: number = 1080;

/** The Wall's widgets, in reading order. */
export const WALL_WIDGET_TYPES = ['strip', 'revenue', 'needs', 'sites', 'feed'] as const;

export type WallWidgetType = (typeof WALL_WIDGET_TYPES)[number];

/** The widgets the Wall no longer has. A saved layout may still name them; see
 * the header. */
export const RETIRED_WALL_WIDGET_TYPES = [
  'attention',
  'portfolio',
  'system',
  'clock',
  'countdown',
  'meetings',
  'assets',
] as const;

/** The settings a widget MAY carry. Each key is applied by the renderer for
 * every type whose spec lists it, and refused by the validator elsewhere. */
export interface WallWidgetSettings {
  /** Only these asset ids, in the layout's own order; absent means every asset. */
  assets?: string[];
  /** Selected pulse totals per asset. Absent uses its configured totals; [] hides them. */
  pulseMetrics?: Record<string, string[]>;
}

export type WallSettingKey = keyof WallWidgetSettings;

export interface WallWidgetSpec {
  type: WallWidgetType;
  /** Operator-facing name, the same the desk uses. */
  label: string;
  /** What the widget shows, as the library panel's facets — two to five
   * nouns, never a sentence. */
  shows: readonly string[];
  /** The weight a freshly added widget gets. */
  defaultWidth: number;
  /** The track floor the renderer applies (`minmax(<rem>, <width>fr)`); 0 = none. */
  minWidthRem: number;
  /**
   * The widest its track may grow; null = none. A capped widget's track is its
   * share of the row by weight, between its floor and this cap, and the
   * widgets beside it take the rest.
   */
  maxWidthRem: number | null;
  /** At most one per layout — the fact it shows is portfolio-wide. */
  unique: boolean;
  /** Belongs in the row that takes the remaining screen height. */
  prefersFill: boolean;
  /**
   * Its place in the one column the Wall becomes on a portrait tablet or a
   * phone: the strip, revenue, the site rows, Needs you, the feed. The sites
   * come before Needs you and the feed because their numbers are what
   * changes. By type, so any saved layout reads the same.
   */
  stackOrder: number;
  /** Renders nothing — and yields its track — when it has nothing to show: an
   * empty track is a hole on the Wall for a feature nobody set up. */
  hidesWhenEmpty: boolean;
  /** The settings keys this widget honours. */
  settings: readonly WallSettingKey[];
  /** Where this widget's OWN configuration lives when it is not a widget
   * setting — the editor's panel renders that form instead of fields. */
  configuredAt?: string;
}

export interface WallWidget {
  /** Stable within the layout; the editor's selection and the renderer's key. */
  id: string;
  type: WallWidgetType;
  /** Grid fraction — see the header above. */
  width: number;
  settings?: WallWidgetSettings;
}

/**
 * A slot that stacks rows of widgets inside a row, so one widget can run the
 * full height beside several (the live feed beside the revenue band and the
 * site rows). It sits in its row's `widgets` like a widget and takes a width
 * like one. One level deep: a column holds rows of widgets and never another
 * column — the types say so and the validator refuses it.
 */
export interface WallColumn {
  /** Shares the widget id space: the editor selects and keys it the same way. */
  id: string;
  type: 'column';
  /** Grid fraction of its row, exactly as a widget's. */
  width: number;
  /** Stacked top to bottom; at most one takes the column's remaining height. */
  rows: WallColumnRow[];
}

/** A row inside a column: widgets side by side, never another column. */
export interface WallColumnRow {
  id: string;
  /** `fill` takes the height the column's other rows leave. */
  height: 'auto' | 'fill';
  widgets: WallWidget[];
}

/** What a row holds, left to right: widgets, and at most depth-1 columns. */
export type WallSlot = WallWidget | WallColumn;

export interface WallRow {
  id: string;
  /** `fill` takes the height the other rows leave; at most one row may. */
  height: 'auto' | 'fill';
  widgets: WallSlot[];
}

export interface WallLayout {
  version: typeof WALL_LAYOUT_VERSION;
  rows: WallRow[];
}

/** One saved layout the current one replaced. */
export interface WallLayoutVersion {
  /** ISO-8601 instant of the save that retired it. */
  savedAt: string;
  /** The operator's own words at Save; the editor requires one. */
  reason: string;
  layout: WallLayout;
}

export interface WallConfig {
  layout: WallLayout;
  /** Newest first, capped at `WALL_LAYOUT_HISTORY_MAX`. */
  history: WallLayoutVersion[];
  /** Present only when the saved `/wall` names a retired widget. Read-side
   * only: `parseWallConfig` sets it and every write door refuses it. */
  retired?: WallRetired;
}

/** What `parseWallConfig` did with a saved `/wall` that names a retired
 * widget. */
export interface WallRetired {
  /** The `/wall` value exactly as saved. The editor's Save is guarded by it,
   * because the guard compares against the store, not against the default
   * drawn in its place. */
  saved: unknown;
  /** The saved current layout named one, so the Wall draws the default. False
   * when only older versions did; those are left out of the history. */
  replaced: boolean;
}

export type WallLayoutCheck =
  | { ok: true; layout: WallLayout }
  | { ok: false; reason: string };

/** A value read out of a document: an object of unknown shape. */
type Row = { readonly [key: string]: unknown };

export const WALL_WIDGET_LIBRARY: Readonly<Record<WallWidgetType, WallWidgetSpec>> = {
  // The one top line. Its countdown is the one at `/countdown`, so the editor
  // shows that form for it.
  strip: {
    type: 'strip',
    label: 'Top strip',
    shows: ['Time and date', 'Next meeting', 'Countdown', 'System state'],
    defaultWidth: 1,
    minWidthRem: 0,
    maxWidthRem: null,
    unique: true,
    prefersFill: false,
    stackOrder: 1,
    hidesWhenEmpty: false,
    settings: [],
    configuredAt: '/countdown',
  },
  revenue: {
    type: 'revenue',
    label: 'Revenue',
    shows: ['Revenue this month', 'Pace', 'Month chart'],
    defaultWidth: 1.55,
    minWidthRem: 0,
    maxWidthRem: null,
    unique: true,
    prefersFill: false,
    stackOrder: 2,
    hidesWhenEmpty: false,
    settings: [],
  },
  needs: {
    type: 'needs',
    label: 'Needs you',
    shows: ['Errors', 'Warnings', 'Urgent tasks'],
    defaultWidth: 1,
    minWidthRem: 0,
    maxWidthRem: null,
    unique: true,
    prefersFill: false,
    stackOrder: 4,
    hidesWhenEmpty: false,
    settings: ['assets'],
  },
  sites: {
    type: 'sites',
    label: 'Sites',
    shows: ['Live users', 'Today vs last week', '30 days', 'Money', 'Issues'],
    defaultWidth: 1,
    minWidthRem: 0,
    maxWidthRem: null,
    unique: true,
    prefersFill: true,
    stackOrder: 3,
    hidesWhenEmpty: false,
    settings: ['assets', 'pulseMetrics'],
  },
  // The live feed: what just happened, newest on top, from its own 30-second
  // read. Never hides — an empty window says so. Its weight is the one it has
  // beside the default's column, so taking it off and adding it back puts
  // back the same Wall; its track is that share of the row between 21 rem and
  // 30 rem.
  feed: {
    type: 'feed',
    label: 'Live feed',
    shows: ['What just happened', 'Newest on top'],
    defaultWidth: 1,
    minWidthRem: 21,
    maxWidthRem: 30,
    unique: true,
    prefersFill: true,
    stackOrder: 5,
    hidesWhenEmpty: false,
    settings: [],
  },
};

export function wallWidgetSpec(type: WallWidgetType): WallWidgetSpec {
  return WALL_WIDGET_LIBRARY[type];
}

/** A slot that is a column rather than a widget. */
export function isWallColumn(slot: WallSlot): slot is WallColumn {
  return slot.type === 'column';
}

/** One row of the layout wherever it sits. */
export interface WallRowPlace {
  row: WallRow | WallColumnRow;
  /** Its index among its siblings: the layout's rows, or its column's rows. */
  index: number;
  /** The column holding it and the top-level row holding that; null at the top. */
  column: WallColumn | null;
  parent: WallRow | null;
}

/** Every row in reading order: each top-level row, then its columns' rows. */
export function wallRowPlaces(layout: WallLayout): WallRowPlace[] {
  return layout.rows.flatMap((row, index) => [
    { row, index, column: null, parent: null },
    ...row.widgets.filter(isWallColumn).flatMap((column) =>
      column.rows.map((inner, innerIndex) => ({ row: inner, index: innerIndex, column, parent: row })),
    ),
  ]);
}

/** Every widget on the Wall, columns' included, in reading order. */
export function wallLayoutWidgets(layout: WallLayout): WallWidget[] {
  return layout.rows.flatMap((row) =>
    row.widgets.flatMap((slot) => (isWallColumn(slot) ? slot.rows.flatMap((inner) => inner.widgets) : [slot])),
  );
}

/**
 * The default Wall: the strip on top; below it a column — revenue beside
 * Needs you, then the site rows taking the rest — beside the live feed, which
 * runs the body's full height.
 */
export const DEFAULT_WALL_LAYOUT: WallLayout = {
  version: WALL_LAYOUT_VERSION,
  rows: [
    {
      id: 'strip',
      height: 'auto',
      widgets: [{ id: 'strip', type: 'strip', width: 1 }],
    },
    {
      id: 'body',
      height: 'fill',
      widgets: [
        {
          id: 'business',
          type: 'column',
          width: 3.1,
          rows: [
            {
              id: 'money',
              height: 'auto',
              widgets: [
                { id: 'revenue', type: 'revenue', width: 1.55 },
                { id: 'needs', type: 'needs', width: 1 },
              ],
            },
            {
              id: 'sites',
              height: 'fill',
              widgets: [{ id: 'sites', type: 'sites', width: 1 }],
            },
          ],
        },
        { id: 'feed', type: 'feed', width: 1 },
      ],
    },
  ],
};

export const EMPTY_WALL_CONFIG: WallConfig = {
  layout: DEFAULT_WALL_LAYOUT,
  history: [],
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWidgetType(value: unknown): value is WallWidgetType {
  return typeof value === 'string' && WALL_WIDGET_TYPES.includes(value as WallWidgetType);
}

function isRetiredType(value: unknown): boolean {
  return typeof value === 'string' && (RETIRED_WALL_WIDGET_TYPES as readonly string[]).includes(value);
}

/**
 * Does this saved layout name a retired widget? Read off the raw value,
 * before validation, because the answer decides whether it is validated at
 * all: a retired widget is drawn as the default, never refused.
 */
export function wallLayoutNamesRetired(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.rows)) return false;
  const slotNames = (slot: unknown): boolean => {
    if (!isRecord(slot)) return false;
    if (slot.type === 'column') {
      return Array.isArray(slot.rows) && slot.rows.some((row) => isRecord(row) && Array.isArray(row.widgets) && row.widgets.some(slotNames));
    }
    return isRetiredType(slot.type);
  };
  return value.rows.some((row) => isRecord(row) && Array.isArray(row.widgets) && row.widgets.some(slotNames));
}

/** A width the editor can produce: inside the bounds, on the step grid. */
export function isWallWidth(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < WALL_WIDTH_MIN || value > WALL_WIDTH_MAX) return false;
  const steps = value / WALL_WIDTH_STEP;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

/**
 * The one rule for "can the Wall draw this". Returns the layout NORMALISED —
 * widths rounded onto the step grid, settings without unknown keys — so the
 * value the lane writes is the value the validator accepted.
 *
 * Reasons are operator sentences: the editor prints them under Save and every
 * write door returns them as the refusal, so the operator reads the same words
 * in the browser and in the terminal.
 */
export function validateWallLayout(value: unknown): WallLayoutCheck {
  if (!isRecord(value)) return { ok: false, reason: 'A layout must be an object.' };
  if (value.version !== WALL_LAYOUT_VERSION) {
    return { ok: false, reason: `A layout must say version ${WALL_LAYOUT_VERSION}.` };
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    return { ok: false, reason: 'A layout needs at least one row.' };
  }
  if (value.rows.length > WALL_MAX_ROWS) {
    return { ok: false, reason: `A layout can hold at most ${WALL_MAX_ROWS} rows.` };
  }

  const ids: LayoutIds = { rows: new Set(), widgets: new Set(), unique: new Set() };
  const rows: WallRow[] = [];
  for (const [rowIndex, rawRow] of value.rows.entries()) {
    const row = checkRow(rawRow, `Row ${rowIndex + 1}`, ids, null);
    if (!row.ok) return row;
    rows.push(row.row);
  }
  if (rows.filter((row) => row.height === 'fill').length > 1) {
    return { ok: false, reason: 'Only one row can take the remaining height.' };
  }
  return { ok: true, layout: { version: WALL_LAYOUT_VERSION, rows } };
}

/** Ids and one-of-a-kind widgets seen so far, across the whole layout — a
 * widget inside a column is still one widget on one Wall. */
interface LayoutIds {
  rows: Set<string>;
  widgets: Set<string>;
  unique: Set<WallWidgetType>;
}

type Checked<K extends string, V> = ({ ok: true } & { [key in K]: V }) | { ok: false; reason: string };

const ID_RULE = 'an id of 1–32 lowercase letters, digits or dashes';
const WIDTH_RULE = `a width between ${WALL_WIDTH_MIN} and ${WALL_WIDTH_MAX} in steps of ${WALL_WIDTH_STEP}`;

/** A width onto the step grid, as the validator stores it. */
function stepWidth(width: number): number {
  return Number((Math.round(width / WALL_WIDTH_STEP) * WALL_WIDTH_STEP).toFixed(2));
}

/** One row, at the top of the layout (`column` null) or inside a column. */
function checkRow(
  rawRow: unknown,
  at: string,
  ids: LayoutIds,
  column: string | null,
): Checked<'row', WallRow> {
  if (!isRecord(rawRow)) return { ok: false, reason: `${at} must be an object.` };
  if (typeof rawRow.id !== 'string' || !ID_RE.test(rawRow.id)) {
    return { ok: false, reason: `${at} needs ${ID_RULE}.` };
  }
  if (ids.rows.has(rawRow.id)) return { ok: false, reason: `${at} repeats the row id "${rawRow.id}".` };
  ids.rows.add(rawRow.id);
  if (rawRow.height !== 'auto' && rawRow.height !== 'fill') {
    return { ok: false, reason: `${at} must say whether its height is "auto" or "fill".` };
  }
  if (!Array.isArray(rawRow.widgets) || rawRow.widgets.length === 0) {
    return { ok: false, reason: `${at} needs at least one widget.` };
  }
  if (rawRow.widgets.length > WALL_MAX_WIDGETS_PER_ROW) {
    return { ok: false, reason: `${at} can hold at most ${WALL_MAX_WIDGETS_PER_ROW} widgets.` };
  }
  const widgets: WallSlot[] = [];
  for (const [slotIndex, rawSlot] of rawRow.widgets.entries()) {
    if (isRecord(rawSlot) && rawSlot.type === 'column') {
      if (column !== null) return { ok: false, reason: 'A column cannot hold another column.' };
      const checked = checkColumn(rawSlot, `${at}, column ${slotIndex + 1}`, ids);
      if (!checked.ok) return checked;
      widgets.push(checked.column);
    } else {
      const checked = checkWidget(rawSlot, `${at}, widget ${slotIndex + 1}`, ids);
      if (!checked.ok) return checked;
      widgets.push(checked.widget);
    }
  }
  return { ok: true, row: { id: rawRow.id, height: rawRow.height, widgets } };
}

/** A column: a width like a widget's, and rows of widgets checked like any row. */
function checkColumn(rawColumn: Row, where: string, ids: LayoutIds): Checked<'column', WallColumn> {
  if (typeof rawColumn.id !== 'string' || !ID_RE.test(rawColumn.id)) {
    return { ok: false, reason: `${where} needs ${ID_RULE}.` };
  }
  if (ids.widgets.has(rawColumn.id)) {
    return { ok: false, reason: `${where} repeats the widget id "${rawColumn.id}".` };
  }
  ids.widgets.add(rawColumn.id);
  if (!isWallWidth(rawColumn.width)) return { ok: false, reason: `${where} needs ${WIDTH_RULE}.` };
  if (!Array.isArray(rawColumn.rows) || rawColumn.rows.length === 0) {
    return { ok: false, reason: `${where} needs at least one row.` };
  }
  if (rawColumn.rows.length > WALL_MAX_ROWS) {
    return { ok: false, reason: `${where} can hold at most ${WALL_MAX_ROWS} rows.` };
  }
  const rows: WallColumnRow[] = [];
  for (const [rowIndex, rawRow] of rawColumn.rows.entries()) {
    const checked = checkRow(rawRow, `${where}, row ${rowIndex + 1}`, ids, rawColumn.id);
    if (!checked.ok) return checked;
    // `checkRow` refused any column inside this one, so every slot is a widget.
    rows.push({ ...checked.row, widgets: checked.row.widgets.filter((slot) => !isWallColumn(slot)) });
  }
  if (rows.filter((row) => row.height === 'fill').length > 1) {
    return { ok: false, reason: 'Only one row in a column can take the remaining height.' };
  }
  return { ok: true, column: { id: rawColumn.id, type: 'column', width: stepWidth(rawColumn.width), rows } };
}

function checkWidget(rawWidget: unknown, where: string, ids: LayoutIds): Checked<'widget', WallWidget> {
  if (!isRecord(rawWidget)) return { ok: false, reason: `${where} must be an object.` };
  if (typeof rawWidget.id !== 'string' || !ID_RE.test(rawWidget.id)) {
    return { ok: false, reason: `${where} needs ${ID_RULE}.` };
  }
  if (ids.widgets.has(rawWidget.id)) {
    return { ok: false, reason: `${where} repeats the widget id "${rawWidget.id}".` };
  }
  ids.widgets.add(rawWidget.id);
  if (isRetiredType(rawWidget.type)) {
    return { ok: false, reason: `${where} is a widget the Wall no longer draws: ${JSON.stringify(rawWidget.type)}.` };
  }
  if (!isWidgetType(rawWidget.type)) {
    return { ok: false, reason: `${where} is a widget type the Wall does not have: ${JSON.stringify(rawWidget.type)}.` };
  }
  const spec = WALL_WIDGET_LIBRARY[rawWidget.type];
  if (spec.unique) {
    if (ids.unique.has(spec.type)) {
      return { ok: false, reason: `${spec.label} can appear only once on the Wall.` };
    }
    ids.unique.add(spec.type);
  }
  if (!isWallWidth(rawWidget.width)) return { ok: false, reason: `${where} needs ${WIDTH_RULE}.` };
  const width = stepWidth(rawWidget.width);

  let settings: WallWidgetSettings | undefined;
  if (rawWidget.settings !== undefined) {
    if (!isRecord(rawWidget.settings)) {
      return { ok: false, reason: `${where} settings must be an object.` };
    }
    for (const key of Object.keys(rawWidget.settings)) {
      if (!spec.settings.includes(key as WallSettingKey)) {
        return { ok: false, reason: `${spec.label} has no "${key}" setting.` };
      }
    }
    // An empty filter reads as "every asset", the answer the editor already
    // gives when the last box is unticked, so a hand-written `[]` is inferred
    // rather than refused.
    const emptyFilter = Array.isArray(rawWidget.settings.assets) && rawWidget.settings.assets.length === 0;
    if (rawWidget.settings.assets !== undefined && !emptyFilter) {
      const list = rawWidget.settings.assets;
      if (!Array.isArray(list)) {
        return { ok: false, reason: `${spec.label}'s asset filter must be a list.` };
      }
      const assetIds: string[] = [];
      for (const id of list) {
        if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) {
          return { ok: false, reason: `${spec.label}'s asset filter holds something that is not an asset id: ${JSON.stringify(id)}.` };
        }
        if (assetIds.includes(id)) {
          return { ok: false, reason: `${spec.label}'s asset filter lists ${id} twice.` };
        }
        assetIds.push(id);
      }
      settings = { assets: assetIds };
    }
    if (rawWidget.settings.pulseMetrics !== undefined) {
      const raw = rawWidget.settings.pulseMetrics;
      if (!isRecord(raw)) return { ok: false, reason: 'Pulse totals must be grouped by site.' };
      const entries: [string, string[]][] = [];
      for (const [asset, metrics] of Object.entries(raw)) {
        if (!ASSET_ID_RE.test(asset)) return { ok: false, reason: 'Pulse totals need a valid site.' };
        if (!Array.isArray(metrics) || metrics.some((metric) => typeof metric !== 'string' || !metric.trim())) {
          return { ok: false, reason: 'Choose pulse totals by their metric names.' };
        }
        if (new Set(metrics).size !== metrics.length) return { ok: false, reason: 'A pulse total can appear only once per site.' };
        entries.push([asset, [...metrics] as string[]]);
      }
      if (entries.length) settings = { ...settings, pulseMetrics: Object.fromEntries(entries) };
    }
  }
  return {
    ok: true,
    widget: settings === undefined
      ? { id: rawWidget.id, type: spec.type, width }
      : { id: rawWidget.id, type: spec.type, width, settings },
  };
}

/**
 * Non-blocking observations the editor shows beside Save. A layout can be
 * drawn and still be a poor Wall; these name the state and leave the decision
 * with the operator. States, not sentences: each is what the TV will look
 * like, drawn as a caution chip, and the fix is a control already beside it.
 */
export function wallLayoutWarnings(layout: WallLayout): string[] {
  const warnings: string[] = [];
  const present = new Set(wallLayoutWidgets(layout).map((w) => w.type));
  if (!layout.rows.some((row) => row.height === 'fill')) {
    warnings.push('Bottom of the TV left empty');
  }
  for (const type of WALL_WIDGET_TYPES) {
    const spec = WALL_WIDGET_LIBRARY[type];
    if (spec.prefersFill && present.has(type)) {
      // Inside a column it stretches only when its own row AND the row
      // holding the column both take the remaining height.
      const place = wallRowPlaces(layout).find(({ row }) =>
        row.widgets.some((w) => !isWallColumn(w) && w.type === type),
      );
      if (place && (place.row.height !== 'fill' || (place.parent !== null && place.parent.height !== 'fill'))) {
        warnings.push(`${spec.label} squeezed into a fixed-height row`);
      }
    }
  }
  if (!present.has('sites')) warnings.push('No sites on the TV');
  if (!present.has('needs')) warnings.push('No alerts on the TV');
  return warnings;
}

/** The editor's one warning for a saved layout that named a retired widget:
 * the state the TV is in, as a chip beside Save. */
export const WALL_RETIRED_WARNING = 'Old layout retired, new default shown';

/** A `retired` marker carried from an earlier parse — the Worker parses the
 * store's `/wall` and the browser parses the payload again. */
function carriedRetired(value: unknown): WallRetired | undefined {
  if (!isRecord(value) || typeof value.replaced !== 'boolean' || !('saved' in value)) return undefined;
  return { saved: value.saved, replaced: value.replaced };
}

/** Read `/wall` out of a parsed `config/tower.json`. Absent → the default;
 * present but undrawable → throws with the validator's own sentence, so a bad
 * file fails the build the way a bad countdown does (`parseDashboardConfig`).
 *
 * A layout naming a retired widget is the one exception: the current layout
 * becomes the default, an older version naming one leaves the history (it
 * could only be reverted to the default), and `retired` keeps the value as
 * saved for the editor's Save guard. */
export function parseWallConfig(value: unknown): WallConfig {
  if (value === undefined || value === null) return EMPTY_WALL_CONFIG;
  if (!isRecord(value)) throw new Error('config/tower.json wall must be an object');
  const replaced = wallLayoutNamesRetired(value.layout);
  let layout = DEFAULT_WALL_LAYOUT;
  if (!replaced) {
    const current = validateWallLayout(value.layout);
    if (!current.ok) throw new Error(`config/tower.json wall.layout: ${current.reason}`);
    layout = current.layout;
  }
  const history: WallLayoutVersion[] = [];
  let droppedVersion = false;
  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) throw new Error('config/tower.json wall.history must be a list');
    for (const [index, entry] of value.history.entries()) {
      if (!isRecord(entry)) throw new Error(`config/tower.json wall.history[${index}] must be an object`);
      if (typeof entry.savedAt !== 'string' || Number.isNaN(Date.parse(entry.savedAt))) {
        throw new Error(`config/tower.json wall.history[${index}].savedAt must be an ISO-8601 instant`);
      }
      if (typeof entry.reason !== 'string') {
        throw new Error(`config/tower.json wall.history[${index}].reason must be a string`);
      }
      if (wallLayoutNamesRetired(entry.layout)) {
        droppedVersion = true;
        continue;
      }
      const version = validateWallLayout(entry.layout);
      if (!version.ok) throw new Error(`config/tower.json wall.history[${index}].layout: ${version.reason}`);
      history.push({ savedAt: entry.savedAt, reason: entry.reason, layout: version.layout });
    }
  }
  const retired = replaced || droppedVersion ? { saved: value, replaced } : carriedRetired(value.retired);
  return retired ? { layout, history, retired } : { layout, history };
}

/** True when two layouts would draw the same Wall. */
export function sameWallLayout(a: WallLayout, b: WallLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The `WallConfig` a Save produces: the new layout becomes current and the one
 * it replaces goes to the top of the history with the operator's reason. Saving
 * an identical layout is not a version — the editor should not offer it.
 */
export function withSavedWallLayout(config: WallConfig, layout: WallLayout, reason: string, savedAt: string): WallConfig {
  if (sameWallLayout(config.layout, layout)) return config;
  const retired = { savedAt, reason, layout: config.layout };
  return {
    layout,
    history: [retired, ...config.history].slice(0, WALL_LAYOUT_HISTORY_MAX),
  };
}

/**
 * Revert is a Save whose layout is an older version — the current layout is
 * retired into the history like any other, so a revert can itself be undone.
 * The reverted entry stays in the history: it is a record of what the Wall
 * showed, not a stack to pop.
 */
export function withRevertedWallLayout(config: WallConfig, historyIndex: number, savedAt: string): WallConfig {
  const entry = config.history[historyIndex];
  if (!entry) return config;
  const stamp = new Date(entry.savedAt);
  const when = Number.isNaN(stamp.getTime()) ? entry.savedAt : stamp.toISOString();
  return withSavedWallLayout(config, entry.layout, `Reverted to the layout saved ${when}`, savedAt);
}

/** A widget id no other widget or column in the layout uses — `<type>`, then
 * `<type>-2`… */
export function nextWallWidgetId(layout: WallLayout, type: WallWidgetType | 'column'): string {
  const taken = new Set(wallRowPlaces(layout).flatMap(({ row }) => row.widgets.map((w) => w.id)));
  if (!taken.has(type)) return type;
  for (let n = 2; ; n += 1) {
    const candidate = `${type}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A row id no other row uses, a column's rows included. */
export function nextWallRowId(layout: WallLayout): string {
  const all = wallRowPlaces(layout);
  const taken = new Set(all.map(({ row }) => row.id));
  for (let n = all.length + 1; ; n += 1) {
    const candidate = `row-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The refusal a changeset's `/wall` ops earn, or `null`. This is the rule at
 * every door: `validateSchemaAndSafety` calls it, so the terminal
 * (`pnpm config:apply`), the Worker's `PUT /api/config`, the ingest's
 * `applyConfigOps` and the dev write lane all refuse the same layout in the
 * same words, and `parseWallConfig` fails the build on one that arrived any
 * other way. A layout is written whole, at `/wall` or `/wall/layout`; a
 * pointer inside one is refused, because a row or a width lifted out of its
 * document cannot be judged on its own.
 */
export function wallOpRefusal(op: unknown, at: string): string | null {
  if (op === null || typeof op !== 'object') return null;
  if ((op as Row).file !== 'config/tower.json') return null;
  const pointer = (op as Row).pointer;
  if (typeof pointer !== 'string') return null;
  if (pointer !== WALL_LAYOUT_POINTER && !pointer.startsWith(`${WALL_LAYOUT_POINTER}/`)) {
    return null;
  }
  // A delete carries the value being REMOVED; the Wall falls back to its
  // default, which it can always draw.
  if ((op as Row).kind === 'file-json-delete') return null;
  if (pointer === WALL_LAYOUT_POINTER) {
    const value = (op as Row).value;
    // `retired` is what a read says about the store; written into it, every
    // later read would believe it.
    if (isRecord(value) && 'retired' in value) {
      return `${at}: config/tower.json /wall.retired is set when the layout is read, never saved.`;
    }
    try {
      // The whole config, history included: a version nobody could draw is a
      // Revert that would break the Wall the moment it is chosen. A saved
      // layout naming a retired widget still reads (as the default), so an
      // Undo that puts one back is not refused.
      parseWallConfig(value);
    } catch (err) {
      return `${at}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  }
  if (pointer === `${WALL_LAYOUT_POINTER}/layout`) {
    const check = validateWallLayout((op as Row).value);
    if (!check.ok) return `${at}: config/tower.json ${pointer}: ${check.reason}`;
    return null;
  }
  // A piece of a layout cannot be checked on its own, and a layout the Wall
  // cannot draw must never reach the TV.
  return `${at}: the Wall's layout is saved whole, at ${WALL_LAYOUT_POINTER} or ${WALL_LAYOUT_POINTER}/layout, never in pieces.`;
}
