// The Tower's view of the config register map and the scalar knobs beside it
// — the same objects the write lane and `pnpm config:apply` validate against
// (`scripts/config-registers.mts`). This module restates no field: it
// re-exports, adds the types, and turns a register plus a row into the
// changeset ops that write it. Nothing here writes.

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

/** The scalar knob a Settings row is editing, by key. */
export function configKnob(key: ConfigKnobKey): ConfigKnob {
  return CONFIG_KNOBS[key];
}

/**
 * The op one knob's Save writes, built from the declaration so the pointer the
 * browser sends and the pointer the lane licenses cannot drift. `expect` is
 * the value the row was rendered from; `useConfigSave` inverts a
 * `file-json-set` by swapping `expect` and `value`.
 */
export function knobSetOp(
  knob: ConfigKnob,
  expect: JsonValue,
  value: JsonValue,
): FileJsonSetOp {
  return {
    kind: "file-json-set",
    // The declaration types `file` as a plain string; `RegisterFile` is that
    // set spelled for TypeScript. `scripts/config-knobs.test.mjs` holds every
    // knob's file to that union.
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

/** Normalize whatever the page has into rows, in file order. */
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
 * A typed value from what an operator typed, decided by the field's own type,
 * so a field cannot be parsed one way and judged another: `"15"` in an
 * `integer` field is the number 15 before `fieldRefusal` sees it, and an empty
 * optional field is `null`, which `storedRow` drops. Every input over a
 * declared field reaches it here; `test/collection-editor.test.tsx` holds the
 * editor to this one.
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
 * A stored value as the text an input seeds with: `fieldFromDraft`'s exact
 * inverse. It takes the value and not the field, because what a stored value
 * looks like is decided by what it is. `KnobEditor`'s `datetime` control keeps
 * its own `toDraft` prop, which is a control format rather than a value
 * format.
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

/** A draft row as it will be stored. Optional fields left blank are dropped
 * rather than written as `""`; a scalar register with nothing but its one
 * field writes the bare value. */
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

/** The things a collection surface does. Each is one op with an exact
 * inverse, which is what makes the Undo in the toast honest. */
export type CollectionChange =
  | { kind: "add"; row: JsonValue; /** rows BEFORE the add — the undo's index */ count: number }
  /**
   * The first row of a per-asset list whose asset has no entry in the file at
   * all. A pointer never creates structure, so this files the whole entry
   * (`{ valueEvents: [row] }` at `/assets/<asset>`) through the holder
   * register beside the list (`holderOf`); its inverse is one delete at the
   * same pointer. A different change from `add` because `{ valueEvents: [] }`
   * is an entry that exists, whose first row appends normally.
   */
  | { kind: "seed"; row: JsonValue; holderExists?: boolean }
  /**
   * `seed`'s exact mirror: the last row of a per-asset list on a register that
   * declares `emptyIsAbsent`, where an entry holding an empty list is a config
   * error. `rows` is the list as the file holds it right now, because the
   * guard is the whole entry, rebuilt as `{ <field>: rows }`; an entry that
   * had grown a second key would not match and the changeset is refused.
   */
  | { kind: "unseed"; rows: readonly JsonValue[] }
  | { kind: "remove"; token: string; expect: JsonValue }
  /**
   * Take one declared optional field back off a row — the exact mirror of a
   * first write, and the only way a mapping goes back to its fallback source.
   * A field left blank is not a field cleared away: `fieldRefusal` refuses
   * `""`. The op is a delete at the field's own pointer guarded by the value
   * being removed; its inverse is the `expectAbsent` set that writes it back.
   */
  | { kind: "unset"; token: string; field: string; expect: JsonValue }
  /** `field: null` sets the whole row — for a row stored as one scalar, or one
   * whose shape is changing (a tracked query gaining its cluster label).
   * `expect` is then the whole previous row. */
  | { kind: "edit"; token: string; field: string | null; expect: JsonValue; value: JsonValue };

export interface CollectionOps {
  /** What the Save writes. */
  op: FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;
  /** What the Undo writes. */
  undo: FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;
}

/**
 * Build the op a change makes, and the op that reverses it. An add is an
 * append, so its inverse deletes the last row, guarded by the row itself as
 * `expect`: if anything moved in between, the changeset is refused. The
 * inverse of a remove puts the row back where it was, by indexed insert
 * (RFC 6902 `add`); `positionedInsert` says which registers may name one.
 * `config/pull.json`, whose rows are opaque, still appends.
 */
export function collectionOps(
  register: ConfigRegister,
  params: RegisterParams,
  change: CollectionChange,
): CollectionOps {
  // The declaration types `file` as a plain string; `RegisterFile` is that
  // set spelled for TypeScript. `scripts/config-registers.test.mjs` asserts
  // the two lists still name the same files.
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
    // The holder's pointer is this container minus its last token.
    const pointer = container.slice(0, -(holder.field.length + 1));
    const entry: JsonValue = {
      [holder.field]: change.kind === "seed" ? [change.row] : [...change.rows],
    };
    // Filing the entry and taking it away are one another's inverse.
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
    // The row goes back where it was: the undo splices in at the same index
    // where `positionedInsert` licenses it; `config/pull.json` keeps the append.
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
 * The object key a new row is filed under (object registers only). An asset
 * register has no key field because its key is not inside the row: the
 * container is keyed by asset id (`keyRule: 'asset-id'`), which comes from the
 * surface as its param.
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
