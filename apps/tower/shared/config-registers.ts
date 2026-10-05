// The Tower's view of the config REGISTER map and the scalar KNOBS beside it —
// the same objects the write lane and `pnpm config:apply` validate against,
// typed by their own authored source (`scripts/config-registers.mts`, bead
// `ro-ujb9.61`).
//
// ONE REPRESENTATION (doc 14). The declaration lives in `scripts/` because the
// pipeline that reads it runs the generated plain-ESM `config-registers.mjs`
// with no TypeScript loader (house style of `scripts/`). This module
// does not restate a single field: it re-exports, adds the types, and adds the
// one thing only the browser needs — turning a register plus a row into the
// changeset OPS that write it. So a column the table renders, a rule the input
// refuses, and a rule the lane refuses are all the same line of the same file.
//
// Nothing here writes. `useCollectionSave` sends what these functions build.

import {
  CONFIG_KNOBS,
  CONFIG_REGISTERS,
  FIXED_FIELD_LABEL,
  LANE_FALLBACK_LABEL,
  LANE_MAPPED_LABEL,
  LANE_MAPPING,
  LANE_MAPPING_TIMING_LABEL,
  OPERATOR_LANE_STATES,
  candidateRefusal,
  clusterSpellingRefusal,
  duplicateIssue,
  duplicateKey,
  fieldOf,
  fieldRefusal,
  fixedFieldLabel,
  holderOf,
  knobEntries,
  knobsForFile,
  laneMappingTiming,
  laneStatuses,
  liveSearchLaneRefusal,
  matchKnob,
  positionedInsert,
  readOnlyFieldRefusal,
  readOnlyRowRefusal,
  resolveContainer,
  rowIssue,
  rowRefusal,
  rowValue,
  type ConfigKnob,
  type ConfigKnobKey,
  type ConfigRegister,
  type ConfigRegisterKey,
  type FieldType,
  type LaneFallback,
  type LaneMapping,
  type LaneMappingTiming,
  type RegisterField,
  type RegisterHolder,
  type RowIssue,
} from "../../../scripts/config-registers.mjs";
import type {
  FileJsonDeleteOp,
  FileJsonInsertOp,
  FileJsonSetOp,
  JsonValue,
  RegisterFile,
} from "./changeset";

export {
  CONFIG_KNOBS,
  CONFIG_REGISTERS,
  FIXED_FIELD_LABEL,
  LANE_FALLBACK_LABEL,
  LANE_MAPPED_LABEL,
  LANE_MAPPING,
  LANE_MAPPING_TIMING_LABEL,
  OPERATOR_LANE_STATES,
  candidateRefusal,
  clusterSpellingRefusal,
  duplicateIssue,
  duplicateKey,
  fieldOf,
  fieldRefusal,
  fixedFieldLabel,
  holderOf,
  knobEntries,
  knobsForFile,
  laneMappingTiming,
  laneStatuses,
  liveSearchLaneRefusal,
  matchKnob,
  positionedInsert,
  readOnlyFieldRefusal,
  readOnlyRowRefusal,
  resolveContainer,
  rowIssue,
  rowRefusal,
  rowValue,
};
export type {
  ConfigKnob,
  ConfigKnobKey,
  ConfigRegister,
  ConfigRegisterKey,
  FieldType,
  LaneFallback,
  LaneMapping,
  LaneMappingTiming,
  RegisterField,
  RegisterHolder,
  RowIssue,
};

/** The register a surface is editing, by key. */
export function configRegister(key: ConfigRegisterKey): ConfigRegister {
  return CONFIG_REGISTERS[key];
}

/** The scalar knob a Settings row is editing, by key (bead `ro-x5gu.8`). */
export function configKnob(key: ConfigKnobKey): ConfigKnob {
  return CONFIG_KNOBS[key];
}

/**
 * The op one knob's Save writes — the same shape `KnobEditor` takes from any
 * other file-owned field, built from the declaration so the pointer the browser
 * sends and the pointer the lane licenses cannot drift apart.
 *
 * `expect` is the value the row was rendered from, which is the concurrency
 * guard; there is no undo op to build here because `useConfigSave` inverts a
 * `file-json-set` by swapping `expect` and `value`.
 */
export function knobSetOp(
  knob: ConfigKnob,
  expect: JsonValue,
  value: JsonValue,
): FileJsonSetOp {
  return {
    kind: "file-json-set",
    // The same boundary `collectionOps` crosses: the declaration types `file` as
    // a plain string, and `RegisterFile` is that set spelled for TypeScript.
    // `scripts/config-knobs.test.mjs` holds every knob's file to that union.
    file: knob.file as RegisterFile,
    pointer: knob.pointer,
    expect,
    value,
  };
}

/** The asset a per-asset container is scoped to. A register without `{asset}`
 * in its container takes none. */
export interface RegisterParams {
  asset?: string;
}

/**
 * The rows a page hands the editor, exactly as its payload holds them: the
 * array for an array register, the keyed object for an object one. Absent while
 * a page is still loading, or when the file has no entry for this asset yet —
 * which is a real state and reads as empty, never as an error.
 */
export type CollectionSource =
  | readonly JsonValue[]
  | Readonly<Record<string, JsonValue>>
  | null
  | undefined;

/** One table row: where it lives, what it holds, and the value the ops guard on. */
export interface CollectionRow {
  /** The row's own identity — the key field's value, or the object key. */
  key: string;
  /** The reference token addressing it inside the container (`3`, `example.com`). */
  token: string;
  /** The row as a field map; a scalar row is expanded into its one field. */
  values: Record<string, JsonValue>;
  /** The row EXACTLY as it is stored — a delete's `expect`. */
  stored: JsonValue;
}

/** Normalize whatever the page has into rows, in file order. The one way a
 * stored item becomes a table row, so a scalar list and an object list cannot
 * grow two renderers. */
export function collectionRows(
  register: ConfigRegister,
  source: CollectionSource,
): CollectionRow[] {
  if (source === null || source === undefined) return [];
  if (register.shape === "array") {
    if (!Array.isArray(source)) return [];
    return source.map((item, index) => {
      const values = rowValue(register, item);
      const keyField = register.keyField;
      const key = keyField == null ? String(index) : String(values[keyField] ?? index);
      return { key, token: String(index), values, stored: item };
    });
  }
  if (Array.isArray(source) || typeof source !== "object") return [];
  return Object.entries(source as Record<string, JsonValue>).map(([key, item]) => ({
    key,
    token: key,
    values: rowValue(register, item),
    stored: item,
  }));
}

/** The columns a table draws, key field first — the declaration's own order.
 * An opaque register has no columns; nothing renders one as a table. */
export function collectionColumns(register: ConfigRegister): RegisterField[] {
  return [...(register.fields ?? [])];
}

/**
 * A typed value from what an operator TYPED, decided by the field's own type.
 *
 * The same declaration the refusal is read from decides the parse, so a field
 * cannot be parsed one way and judged another: `"15"` in an `integer` field is
 * the number 15 before `fieldRefusal` ever sees it, and an empty optional field
 * is `null`, which `storedRow` then drops rather than writing as a blank string.
 *
 * EVERY input over a declared field reaches it here (bead `ro-7mef`): a
 * `CollectionEditor` cell, its Add form, and `validateRegisterField` behind a
 * `KnobEditor` row. The editor carried an identical private copy from bead
 * `ro-x5gu.1` — two parsers for one declaration, which is the second
 * representation doc 14 exists to prevent, and which would have shown up as a
 * new field type handled in one place and saved as a raw string in the other.
 * `test/collection-editor.test.tsx` holds the editor to this one.
 */
export function fieldFromDraft(field: RegisterField, raw: string): JsonValue {
  const text = raw.trim();
  if (field.type === "boolean") return text === "true";
  if (text === "") return field.required ? "" : null;
  if (field.type === "number" || field.type === "integer") {
    const n = Number(text);
    return Number.isNaN(n) ? text : n;
  }
  if (field.type === "string-list") {
    return text
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  return text;
}

/**
 * THE OTHER DIRECTION: a stored value as the text an input seeds with, and
 * `fieldFromDraft`'s exact inverse (bead `ro-hem5`).
 *
 * Beside the parse it inverts, because the pair only stays a pair if it is
 * written as one. `CollectionEditor` held this half privately while
 * `KnobEditor` seeded with `String(current)` — which agrees for a string, an
 * enum, a date and an integer, and disagrees for every other declared type: a
 * boolean renders `"true"` here and `"[object Object]"`-adjacent nonsense
 * there, a `string-list` renders `"a, b"` here and `"a,b"` there, an object
 * renders JSON here and `"[object Object]"` there. None of those types is
 * declared as a knob TODAY, which is why this was not a live defect — and is
 * exactly why it had to be fixed before one is, since the failure is an input
 * seeded with a value the parse cannot round-trip and a row saving something
 * the operator never typed.
 *
 * It takes the VALUE and not the field on purpose: what a stored value looks
 * like is decided by what it is, and a signature that also took a field would
 * invite a caller to pass one that disagrees with the value in hand.
 * `KnobEditor`'s `datetime` control keeps its own `toDraft` prop, which is a
 * CONTROL format — what `<input type="datetime-local">` will accept — rather
 * than a value format, and is not this.
 */
export function fieldToDraft(value: JsonValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A blank draft for the Add form: every declared field, empty. */
export function blankRow(register: ConfigRegister): Record<string, JsonValue> {
  const draft: Record<string, JsonValue> = {};
  for (const field of register.fields ?? []) {
    draft[field.name] = field.type === "boolean" ? false : "";
  }
  return draft;
}

/**
 * A draft row as it will be STORED.
 *
 * Optional fields left blank are dropped rather than written as `""` — an
 * omitted `to` is "the subscription is live", and a blank string there would be
 * a month nobody can parse. A scalar register with nothing but its one field
 * writes the bare value, which is what the file already holds.
 */
export function storedRow(
  register: ConfigRegister,
  draft: Record<string, JsonValue>,
): JsonValue {
  const entry: Record<string, JsonValue> = {};
  for (const field of register.fields ?? []) {
    const value = draft[field.name];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "" && !field.required) continue;
    entry[field.name] = typeof value === "string" ? value.trim() : value;
  }
  const scalar = register.scalarField;
  if (scalar !== undefined && Object.keys(entry).length === 1 && scalar in entry) {
    return entry[scalar] as JsonValue;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// The ops. One action, one changeset — and each carries its own way back.
// ---------------------------------------------------------------------------

/** The three things a collection surface does. Each is ONE op, and each has an
 * exact inverse, which is what makes the Undo in the toast honest. */
export type CollectionChange =
  | { kind: "add"; row: JsonValue; /** rows BEFORE the add — the undo's index */ count: number }
  /**
   * The FIRST row of a per-asset list whose asset has no entry in the file at
   * all. A pointer never creates structure, so this one files the whole entry
   * — `{ valueEvents: [row] }` at `/assets/<asset>`, through the holder
   * register beside the list (`holderOf`). Still one op and one changeset, and
   * still exactly invertible: one delete at the same pointer.
   *
   * It is a DIFFERENT change from `add` because absence and emptiness are
   * different states of these files: `{ valueEvents: [] }` is an entry that
   * exists and declares nothing, and its first row appends normally.
   */
  | { kind: "seed"; row: JsonValue; holderExists?: boolean }
  /**
   * `seed`'s exact mirror: the LAST row of a per-asset list on a register that
   * declares `emptyIsAbsent` — a file where an entry holding an empty list is a
   * CONFIG ERROR rather than a declaration of nothing.
   * `config/serp-panel.README.md` refuses `queries: []` and skips an absent
   * asset silently, so leaving the empty entry behind would turn "this asset
   * stopped buying a panel" into "this asset's panel fails every Monday".
   *
   * `rows` is the list as the file holds it right now, because the guard is the
   * whole ENTRY: it is rebuilt here as `{ <field>: rows }`, the same way `seed`
   * builds the one it writes. An entry that had grown a second key would not
   * match that `expect` and the changeset is refused — which is the safe
   * direction, since the alternative is deleting a key nobody looked at.
   */
  | { kind: "unseed"; rows: readonly JsonValue[] }
  | { kind: "remove"; token: string; expect: JsonValue }
  /**
   * Take ONE declared OPTIONAL field back off a row (bead `ro-pkpz`) — the
   * exact mirror of a first write, and the only way a mapping goes back to
   * reading its fallback source.
   *
   * A field left BLANK is not a field cleared AWAY: `fieldRefusal` reads `""`
   * as a blank string and refuses it for every string field, required or not,
   * so emptying the box was never an answer. The op is a delete at the field's
   * own pointer guarded by the value being removed, and its inverse is the
   * `expectAbsent` set that would write it back.
   */
  | { kind: "unset"; token: string; field: string; expect: JsonValue }
  /** `field: null` sets the WHOLE row — the only honest write for a row that is
   * stored as one scalar, or one whose shape is changing (a tracked query
   * gaining its cluster label, an optional field cleared away rather than
   * written as a null). `expect` is then the whole previous row. */
  | { kind: "edit"; token: string; field: string | null; expect: JsonValue; value: JsonValue };

export interface CollectionOps {
  /** What the Save writes. */
  op: FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;
  /** What the Undo writes. */
  undo: FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;
}

/**
 * Build the op a change makes, and the op that reverses it.
 *
 * An add is an APPEND, so its inverse deletes the last row — guarded by the row
 * itself as `expect`, which is what makes addressing an array entry by index
 * safe: if anything moved in between, the value at that index is not what the
 * undo expected and the whole changeset is refused.
 *
 * THE INVERSE OF A REMOVE PUTS THE ROW BACK WHERE IT WAS (bead `ro-asj9`). A
 * delete splices, so an undo that could only append returned the row at the END
 * of the list — the row came back, its neighbours' order did not, which is
 * visible wherever a table is drawn in file order (/financials is). An indexed
 * insert is what RFC 6902's `add` has always meant for an array, and
 * `positionedInsert` says which registers may name one: every array register
 * whose rows have declared fields. `config/pull.json`, the one whose rows are
 * opaque, still appends — nothing reads the order of the endpoints in it.
 */
export function collectionOps(
  register: ConfigRegister,
  params: RegisterParams,
  change: CollectionChange,
): CollectionOps {
  // The cast is the boundary between two vocabularies, the same one the write
  // lane makes: the declaration types `file` as a plain string (it is shared
  // with the terminal and knows nothing of this app's unions), and `RegisterFile` is that same
  // set spelled for TypeScript. `scripts/config-registers.test.mjs` asserts the
  // two lists still name the same files.
  const file = register.file as RegisterFile;
  const container = resolveContainer(register, params);
  if (change.kind === "seed" || change.kind === "unseed") {
    const holder = holderOf(register);
    if (holder === null) {
      throw new Error(`${register.container} is not a per-site list — it has no entry to file first`);
    }
    if (change.kind === "seed" && change.holderExists === true) {
      if (register.addableContainer !== true) throw new Error("This list cannot be initialized separately");
      const value = [change.row];
      return {
        op: { kind: "file-json-insert", file, pointer: container, value },
        undo: { kind: "file-json-delete", file, pointer: container, expect: value },
      };
    }
    // The holder's pointer is this container minus its last token, already
    // resolved — so the asset id is the one `resolveContainer` just validated
    // rather than a second reading of `params`.
    const pointer = container.slice(0, -(holder.field.length + 1));
    const entry: JsonValue = {
      [holder.field]: change.kind === "seed" ? [change.row] : [...change.rows],
    };
    // The same op pair, swapped: filing the entry and taking it away are one
    // another's inverse, so they are one branch rather than two that could
    // drift apart.
    const insert: FileJsonInsertOp = { kind: "file-json-insert", file, pointer, value: entry };
    const remove: FileJsonDeleteOp = { kind: "file-json-delete", file, pointer, expect: entry };
    if (change.kind === "seed" && register.seedUndo === "list") {
      return { op: insert, undo: { kind: "file-json-delete", file, pointer: container, expect: [change.row] } };
    }
    return change.kind === "seed" ? { op: insert, undo: remove } : { op: remove, undo: insert };
  }
  if (change.kind === "add") {
    const pointer =
      register.shape === "array"
        ? `${container}/-`
        : `${container}/${rowKey(register, change.row, params)}`;
    const at = register.shape === "array" ? `${container}/${change.count}` : pointer;
    return {
      op: { kind: "file-json-insert", file, pointer, value: change.row },
      undo: { kind: "file-json-delete", file, pointer: at, expect: change.row },
    };
  }
  if (change.kind === "remove") {
    const pointer = `${container}/${change.token}`;
    // The row goes back WHERE IT WAS (bead `ro-asj9`). A delete splices, so the
    // undo has to splice in at the same index — which is what RFC 6902's `add`
    // means for an array, and what `positionedInsert` licenses for every
    // register whose rows have declared fields. The one that has none
    // (`config/pull.json`) keeps the append, because nothing reads its order.
    const back =
      register.shape === "array" && !positionedInsert(register)
        ? `${container}/-`
        : `${container}/${change.token}`;
    return {
      op: { kind: "file-json-delete", file, pointer, expect: change.expect },
      undo: { kind: "file-json-insert", file, pointer: back, value: change.expect },
    };
  }
  if (change.kind === "unset") {
    // The two ops are one another's inverse at one pointer, so they are built
    // together here rather than left to two surfaces to agree on.
    const pointer = `${container}/${change.token}/${change.field}`;
    return {
      op: { kind: "file-json-delete", file, pointer, expect: change.expect },
      undo: { kind: "file-json-set", file, pointer, expectAbsent: true, value: change.expect },
    };
  }
  const pointer =
    change.field === null
      ? `${container}/${change.token}`
      : `${container}/${change.token}/${change.field}`;
  return {
    op: { kind: "file-json-set", file, pointer, expect: change.expect, value: change.value },
    undo: { kind: "file-json-set", file, pointer, expect: change.value, value: change.expect },
  };
}

/** Is this stored row one bare value rather than an object? A string list's rows
 * always are; a tracked query's row is one until it gains a cluster label. It
 * decides whether an edit addresses a field or the row. */
export function storedIsScalar(stored: JsonValue): boolean {
  return stored === null || typeof stored !== "object" || Array.isArray(stored);
}

/**
 * The object key a new row is filed under (object registers only).
 *
 * An ASSET register has no key FIELD because its key is not inside the row: the
 * container is keyed by asset id (`keyRule: 'asset-id'`), and which asset that
 * is comes from the surface, as its param. Without this fallback the only rows
 * an object register could file were ones carrying their own key, and every
 * asset register carries none — so filing an asset's whole entry (a first
 * tracked query, a missing roster row) had to be hand-built beside the lane
 * instead of going through it.
 */
function rowKey(
  register: ConfigRegister,
  row: JsonValue,
  params: RegisterParams,
): string {
  const values = rowValue(register, row);
  const named = register.keyField == null ? undefined : values[register.keyField];
  const keyed = register.keyRule === "asset-id" ? params.asset : undefined;
  return String(named ?? keyed ?? "");
}
