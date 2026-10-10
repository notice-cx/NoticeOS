// Authored configuration pipeline. Generate its Node runtime and declarations
// with pnpm config:generate; config:check rejects stale generated files.
import {
  ASSET_STATUSES as ASSET_STATUS, STORE_COLUMNS as ASSET_COLUMNS,
  DISPLAY_NAME_MAX, CONFIG_ASSET_KEY_RE as ASSET_ID_RE,
  NO_NIGHTLY_REPORT_POINTER, noNightlyReportOpRefusal,
} from '../packages/contract/src/configuration.mjs';
import type { Changeset, ChangesetOp, JsonValue, FileJsonSetOp, FileJsonInsertOp, FileJsonDeleteOp } from '../packages/contract/src/configuration.mjs';
export type { Changeset, ChangesetOp, JsonValue, FileJsonSetOp, FileJsonSetGuardedOp, FileJsonSetFirstOp, FileJsonInsertOp, FileJsonDeleteOp, StoreAssetSetOp } from '../packages/contract/src/configuration.mjs';
export { ASSET_STATUS, DISPLAY_NAME_MAX, ASSET_ID_RE };

/** `builtIn`: the saved document holds no key at this pointer, so `current` is
 * the built-in copy's value there and the write creates the key (`shownValue`). */
export type Resolved = { op: ChangesetOp; current: JsonValue | typeof MISSING; expect?: JsonValue | typeof MISSING; builtIn?: true };
export type Mismatch = { op: ChangesetOp; current: JsonValue | typeof MISSING; expect: JsonValue | typeof MISSING };
export interface StoreLane { column(asset: string, column: string): Promise<JsonValue | typeof MISSING> }
export type DocumentReader = (file: string) => Promise<unknown>;
type FileOp = FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;
type RegisterMatch = NonNullable<ReturnType<typeof matchRegister>>;

import {
  ASSET_PARAM,
  SETTABLE_FILES,
  assetIdFields,
  documentStamp,
  assetRosterFile,
  candidateRefusal,
  clusterSpellingRefusal,
  containerRegExp,
  fieldOf,
  fieldRefusal,
  isRowToken,
  knobEntries,
  knobsForFile,
  laneStatuses,
  legalRowPointer,
  liveSearchLaneRefusal,
  matchKnob,
  matchRegister,
  positionedInsert,
  readOnlyFieldRefusal,
  readOnlyRowRefusal,
  registerEntries,
  registerFiles,
  registerStamps,
  registersForFile,
  rosterAssetIds,
  rowRefusal,
  rowValue,
} from './config-registers.mjs';

export { CONFIG_KNOBS, CONFIG_REGISTERS, DOCUMENT_STAMPS } from './config-registers.mjs';

// The Wall's layout rule is read here so every door runs it; `wall-layout.mjs`
// has no `node:` import, so the bundle is safe.
import { wallOpRefusal } from './wall-layout.mjs';
import { schedulesOpRefusal } from './scheduled-jobs.mjs';
import { productUseStagesRefusal } from '../packages/contract/src/product-use.mjs';

// The safety allowlist: file ops may only touch these files, store ops only
// these columns. Explicit, never a config/ glob.
export const ALLOWED_FILES: ReadonlySet<string> = new Set(SETTABLE_FILES);
export const STORE_COLUMNS: ReadonlySet<string> = new Set(ASSET_COLUMNS);
/**
 * Every config file the store holds a document for: the wholesale-settable
 * files, every file a register names, and every file a knob names. What
 * `pnpm config:seed` loads, `pnpm config:export` writes back, and the Workers
 * ask the store for before falling back to the compiled-in copy.
 */
export const CONFIG_DOCUMENT_FILES = Object.freeze(
  [
    ...new Set([
      ...SETTABLE_FILES,
      ...registerFiles(),
      ...knobEntries().map(([, knob]) => knob.file),
    ]),
  ].sort(),
);

/** A config file's name as the Postgres store keys its document and its
 * changes: the file's name without folder or `.json`, `config/tower.json` →
 * `tower` (db/postgres/model.json, config_documents.file). Null for a path
 * that is not a top-level `config/*.json` of that grammar. */
export function configDocumentKey(file: string): string | null {
  return /^config\/([a-z0-9][a-z0-9-]*)\.json$/u.exec(file)?.[1] ?? null;
}

/** The config file a stored document key names: `tower` → `config/tower.json`. */
export function configDocumentFile(documentKey: string): string {
  return `config/${documentKey}.json`;
}

// The asset lifecycle's add/remove list: the registers marked `assetRegister`,
// which an asset is born into and deleted out of. Not a list of everything
// insert/delete may touch — other containers are reached through
// `matchRegister`. Being able to add or remove an asset's whole entry is a
// different permission from rewriting one, which is why most of these files
// are not in ALLOWED_FILES. `scripts/config-apply-core.test.mjs` pins the set.
export const ADDABLE_CONTAINERS: ReadonlyMap<string, { shape: "object" | "array"; parent: string }> = new Map(
  registerEntries()
    .filter(([, register]) => register.assetRegister === true)
    .map(([, register]) => [register.file, { shape: register.shape, parent: register.container }]),
);

/**
 * The keys a wholesale-editable file may gain or lose: one document at one
 * exact pointer, nothing under it. A pointer set never creates a key, and the
 * default (the Wall's layout, the countdown, the no-report list) has exactly
 * one representation, in the code — so a file nobody has saved one in holds
 * `null` or no key at all (`readsAsUnsaved`). Each is added and removed whole.
 * What a document must contain is decided per document: `wallOpRefusal`,
 * the countdown form plus `parseDashboardConfig`, `noNightlyReportOpRefusal`.
 */
export const ADDABLE_DOCUMENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['config/tower.json', ['/wall', '/countdown']],
  ['config/constants.json', ['/schedules', NO_NIGHTLY_REPORT_POINTER]],
]);

/** Is this exact pointer one of the declared documents above? */
export function declaredDocument(file: string, pointer: string): boolean {
  const match = matchRegister(file, pointer);
  return (ADDABLE_DOCUMENTS.get(file) ?? []).includes(pointer) ||
    (match?.register.addableContainer === true && match.rest.length === 0);
}

/**
 * A declared document nobody has saved is one state however its file spells
 * it: the product's `config/tower.json` ships `"wall": null`, while a store
 * seeded without the key holds no `/wall` at all, and every reader treats the
 * two alike. So at a declared document's own pointer — and nowhere else — a
 * stored `null` reads as absent and a guard of `null` means absent, and the
 * write then creates the key. A saved document is compared exactly.
 */
function readsAsUnsaved(file: string, pointer: string, value: JsonValue | typeof MISSING): JsonValue | typeof MISSING {
  return value === null && declaredDocument(file, pointer) ? MISSING : value;
}

/**
 * A key the saved document does not hold reads as the built-in copy's value,
 * because every reader is store-first per key (`resolveTowerConfig`,
 * `ruleConfigFromConstants`) and that is what the page showed. The write then
 * creates the key, and the object keys on the way to it; once it exists it is
 * guarded by the saved value. The built-in copy is also the licence: only a
 * key it holds may be created, through object keys only, and never inside a
 * register, whose rows are born by `file-json-insert` alone.
 */
async function shownValue(
  op: FileJsonSetOp,
  saved: JsonValue | typeof MISSING,
  builtIn: (file: string) => Promise<unknown>,
): Promise<JsonValue | typeof MISSING> {
  if (saved !== MISSING || matchRegister(op.file, op.pointer) !== null) return saved;
  let cur: unknown = await builtIn(op.file);
  for (const tok of parsePointer(op.pointer)) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return MISSING;
    if (!Object.prototype.hasOwnProperty.call(cur, tok)) return MISSING;
    cur = (cur as Record<string, unknown>)[tok];
  }
  return cur as JsonValue;
}

/** Create the missing object keys on the way to a pointer — only for a set
 * whose key the built-in copy licensed (`shownValue`). A key that holds
 * something other than an object is a document of another shape, refused. */
function createParents(doc: unknown, pointer: string): void {
  let cur = doc;
  for (const tok of parsePointer(pointer).slice(0, -1)) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      throw new ChangesetError(`pointer ${pointer} walks into a non-object at "${tok}"`);
    }
    const holder = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(holder, tok)) holder[tok] = {};
    cur = holder[tok];
  }
}

/**
 * Keys the product retired, which an installation's stored copy may still
 * carry. Licenses a delete and nothing else — no insert, no first write — so
 * a retired key can leave a store and never come back through this pipeline.
 */
export const RETIRED_KEYS: ReadonlyMap<string, readonly RegExp[]> = new Map([
  [
    'config/integrations.json',
    [/^\/honestyRule$/, /^\/stateMeaning$/, /^\/catalog\/\d+\/(?:liveMeans|credentialNote|perProperty)$/],
  ],
  ['config/signal-panels.json', [/^\/purpose$/, /^\/refresh\/costNote$/]],
  ['config/entities.json', [/^\/purpose$/]],
  ['config/counters.json', [/^\/intervalMinutes$/]],
]);

/** Is this pointer a key the product retired from this file? */
export function retiredKey(file: string, pointer: string): boolean {
  return (RETIRED_KEYS.get(file) ?? []).some((pattern) => pattern.test(pointer));
}

/** RFC 6902's `add` spells an array append this way. */
const ARRAY_APPEND_TOKEN = '-';

/** A validation/apply refusal. The CLI prints it as a clean `✘` line; the lane
 * turns it into a 422 body. Never a stack trace either way. */
export class ChangesetError extends Error {}

// RFC 6901 JSON Pointer: resolve and set on a parsed JSON value.
function unescapeToken(t: string): string {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new ChangesetError(`invalid JSON pointer (must start with "/"): ${JSON.stringify(pointer)}`);
  }
  return pointer.slice(1).split('/').map(unescapeToken);
}

/** "there is nothing there" — a pointer that resolves nowhere, or an asset the
 * store does not have. Distinct from a present `null`, and rendered `(absent)`. */
export const MISSING = Symbol('missing');

/**
 * Does this op expect nothing to be there? JSON cannot say "absent", so a
 * `file-json-set` says which it means: `expect` for a value, `expectAbsent:
 * true` for a key that is not there, never both. The same word the mismatch
 * list puts on the wire coming back.
 */
export function expectsAbsent(op: unknown): boolean {
  return op !== null && typeof op === 'object' && 'expectAbsent' in op && op.expectAbsent === true;
}

/** Resolve a pointer; returns MISSING if any segment is absent. */
export function pointerGet(doc: unknown, pointer: string): JsonValue | typeof MISSING {
  const tokens = parsePointer(pointer);
  let cur = doc;
  for (const tok of tokens) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(tok)) return MISSING;
      const i = Number(tok);
      if (i >= cur.length) return MISSING;
      cur = cur[i];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return MISSING;
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      return MISSING;
    }
  }
  return cur as JsonValue;
}

/**
 * Set a pointer's target in place; every parent must already exist. `create`
 * is the one exception, a single object key wide: the last token may be a key
 * the container does not have yet (a first write into a declared optional
 * field). An array index is never created; that is `pointerInsert`'s
 * question. The one other key a set may create is one the built-in copy holds
 * (`createParents`).
 */
export function pointerSet(doc: unknown, pointer: string, value: JsonValue, { create = false }: { create?: boolean } = {}): void {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) {
    throw new ChangesetError('refusing to replace the whole document (empty pointer)');
  }
  let cur = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i]!;
    if (Array.isArray(cur)) {
      const idx = Number(tok);
      if (!/^\d+$/.test(tok) || idx >= cur.length) {
        throw new ChangesetError(`pointer ${pointer} walks off an array at "${tok}"`);
      }
      cur = cur[idx];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) {
        throw new ChangesetError(`pointer ${pointer} walks through a missing key "${tok}"`);
      }
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      throw new ChangesetError(`pointer ${pointer} walks into a non-object at "${tok}"`);
    }
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!/^\d+$/.test(last) || idx >= cur.length) {
      throw new ChangesetError(`pointer ${pointer} sets an out-of-range array index "${last}"`);
    }
    cur[idx] = value;
  } else if (cur !== null && typeof cur === 'object') {
    if (!create && !Object.prototype.hasOwnProperty.call(cur, last)) {
      throw new ChangesetError(`pointer ${pointer} sets a missing key "${last}"`);
    }
    (cur as Record<string, unknown>)[last] = value;
  } else {
    throw new ChangesetError(`pointer ${pointer} cannot set into a non-object`);
  }
}

/** Walk to a pointer's parent container, returning `[container, lastToken]`.
 * Never invents the container. */
function pointerParent(doc: unknown, pointer: string): [unknown, string] {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) {
    throw new ChangesetError(`pointer ${JSON.stringify(pointer)} names the whole document`);
  }
  let cur = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i]!;
    if (Array.isArray(cur)) {
      const idx = Number(tok);
      if (!/^\d+$/.test(tok) || idx >= cur.length) {
        throw new ChangesetError(`pointer ${pointer} walks off an array at "${tok}"`);
      }
      cur = cur[idx];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) {
        throw new ChangesetError(`pointer ${pointer} walks through a missing key "${tok}"`);
      }
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      throw new ChangesetError(`pointer ${pointer} walks into a non-object at "${tok}"`);
    }
  }
  return [cur, tokens[tokens.length - 1]!];
}

/**
 * Add a value at a pointer that resolves nowhere — a new object key, or `-`
 * to append to an array. Refuses to overwrite: `resolveOps()` catches a taken
 * key first as a mismatch; this is the second lock, on the write itself.
 */
export function pointerInsert(doc: unknown, pointer: string, value: JsonValue): void {
  const [container, last] = pointerParent(doc, pointer);
  if (Array.isArray(container)) {
    // `-` appends; an index splices in at that position (RFC 6902 `add`),
    // which is what undoing a removal needs. Past the end is refused rather
    // than silently appended.
    if (last === ARRAY_APPEND_TOKEN) {
      container.push(value);
      return;
    }
    const idx = Number(last);
    if (!/^\d+$/.test(last) || idx > container.length) {
      throw new ChangesetError(
        `pointer ${pointer} inserts at "${last}": only "-" (append) or an index from 0 to ${container.length} is allowed`,
      );
    }
    container.splice(idx, 0, value);
    return;
  }
  if (container === null || typeof container !== 'object') {
    throw new ChangesetError(`pointer ${pointer} cannot insert into a non-object`);
  }
  if (Object.prototype.hasOwnProperty.call(container, last)) {
    throw new ChangesetError(`pointer ${pointer} already exists — refusing to overwrite it`);
  }
  (container as Record<string, unknown>)[last] = value;
}

/**
 * Remove the value at a pointer. An array element is spliced out rather than
 * holed: a `null` in the middle of a list would be a new kind of entry nobody
 * handles.
 */
export function pointerDelete(doc: unknown, pointer: string): void {
  const [container, last] = pointerParent(doc, pointer);
  if (Array.isArray(container)) {
    const idx = Number(last);
    if (!/^\d+$/.test(last) || idx >= container.length) {
      throw new ChangesetError(`pointer ${pointer} removes an out-of-range array index "${last}"`);
    }
    container.splice(idx, 1);
    return;
  }
  if (container === null || typeof container !== 'object') {
    throw new ChangesetError(`pointer ${pointer} cannot remove from a non-object`);
  }
  if (!Object.prototype.hasOwnProperty.call(container, last)) {
    throw new ChangesetError(`pointer ${pointer} removes a missing key "${last}"`);
  }
  delete (container as Record<string, unknown>)[last];
}

// JSON deep-equal for the expect guard.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

// Schema validation and the safety allowlist. Rejections name the exact op.
export function validateSchemaAndSafety(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ChangesetError('changeset must be a JSON object');
  }
  const cs = input as Record<string, unknown>;
  if (cs.version !== 1) {
    throw new ChangesetError(`unsupported changeset version ${JSON.stringify(cs.version)} (this tool speaks version 1)`);
  }
  if (typeof cs.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cs.slug)) {
    throw new ChangesetError(`slug must be kebab-case, got ${JSON.stringify(cs.slug)}`);
  }
  if (typeof cs.createdAt !== 'string' || Number.isNaN(Date.parse(cs.createdAt))) {
    throw new ChangesetError(`createdAt must be an ISO-8601 timestamp, got ${JSON.stringify(cs.createdAt)}`);
  }
  if (!Array.isArray(cs.ops) || cs.ops.length === 0) {
    throw new ChangesetError('ops must be a non-empty array');
  }

  cs.ops.forEach((raw: unknown, i: number) => {
    const at = `op #${i + 1}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ChangesetError(`${at}: must be an object`);
    }
    const op = raw as Record<string, unknown>;
    if (op.kind === 'file-json-set') {
      if (typeof op.pointer !== 'string' || (op.pointer !== '' && !op.pointer.startsWith('/'))) {
        throw new ChangesetError(`${at}: pointer must be an RFC 6901 JSON Pointer, got ${JSON.stringify(op.pointer)}`);
      }
      if (op.pointer === '') {
        throw new ChangesetError(`${at}: refusing to replace an entire file (empty pointer)`);
      }
      // One guard, and it says which fact it means: a value, or an absence.
      if ('expectAbsent' in op && op.expectAbsent !== true) {
        throw new ChangesetError(
          `${at}: "expectAbsent" is true or is not there at all, got ${JSON.stringify(op.expectAbsent)}`,
        );
      }
      if ('expect' in op && expectsAbsent(op)) {
        throw new ChangesetError(`${at}: send "expect" or "expectAbsent", never both`);
      }
      if (!('expect' in op) && !expectsAbsent(op)) {
        throw new ChangesetError(`${at}: missing "expect" (the concurrency guard)`);
      }
      if (!('value' in op)) throw new ChangesetError(`${at}: missing "value"`);
      validateSetTarget(at, raw as FileJsonSetOp);
    } else if (op.kind === 'file-json-insert' || op.kind === 'file-json-delete') {
      validateAddRemove(at, raw as FileJsonInsertOp | FileJsonDeleteOp);
    } else if (op.kind === 'store-asset-set') {
      if (typeof op.asset !== 'string' || !ASSET_ID_RE.test(op.asset)) {
        throw new ChangesetError(`${at}: asset id ${JSON.stringify(op.asset)} is not a valid asset key`);
      }
      if (!STORE_COLUMNS.has(op.column as string)) {
        throw new ChangesetError(
          `${at}: column ${JSON.stringify(op.column)} is not store-editable — only ${[...STORE_COLUMNS].join(', ')} (db/README sanctions these two)`,
        );
      }
      if (!('expect' in op)) throw new ChangesetError(`${at}: missing "expect" (the concurrency guard)`);
      if (!('value' in op)) throw new ChangesetError(`${at}: missing "value"`);
      if (op.column === 'status' && !(ASSET_STATUS as readonly unknown[]).includes(op.value)) {
        throw new ChangesetError(
          `${at}: status must be one of ${ASSET_STATUS.join(' | ')}, got ${JSON.stringify(op.value)}`,
        );
      }
      if (op.column === 'sense_only' && op.value !== 0 && op.value !== 1) {
        throw new ChangesetError(`${at}: sense_only must be 0 or 1, got ${JSON.stringify(op.value)}`);
      }
      if (
        op.column === 'display_name' &&
        (typeof op.value !== 'string' ||
          op.value.trim().length === 0 ||
          op.value.trim().length > DISPLAY_NAME_MAX)
      ) {
        throw new ChangesetError(
          `${at}: display_name must be 1–${DISPLAY_NAME_MAX} characters, got ${JSON.stringify(op.value)}`,
        );
      }
    } else {
      throw new ChangesetError(`${at}: unknown op kind ${JSON.stringify(op.kind)}`);
    }

    // Document-shaped rules (the Wall's layout, the schedules, the no-report
    // list) are asked after the op's own kind and pointer are known to be
    // legal, so "unknown op kind" stays the answer to an unknown op kind.
    const undrawable = wallOpRefusal(op, at);
    if (undrawable !== null) throw new ChangesetError(undrawable);
    const unschedulable = schedulesOpRefusal(raw as ChangesetOp);
    if (unschedulable !== null) throw new ChangesetError(unschedulable);
    const undeclarable = noNightlyReportOpRefusal(op);
    if (undeclarable !== null) throw new ChangesetError(`${at}: ${undeclarable}`);
  });

  // A splice renumbers every entry after it, so a second index-addressed op in
  // the same list would resolve against indices that no longer exist. One
  // splice per changeset; an append renumbers nothing and does not count.
  const arraySplices = new Map();
  for (const op of cs.ops as ChangesetOp[]) {
    if (op.kind !== 'file-json-delete' && op.kind !== 'file-json-insert') continue;
    const row = rowMatch(op.file, op.pointer, op.kind);
    if (row === null || row.register.shape !== 'array') continue;
    if (op.kind === 'file-json-insert' && row.token === ARRAY_APPEND_TOKEN) continue;
    const where = `${op.file}${row.container}`;
    const seen = (arraySplices.get(where) ?? 0) + 1;
    arraySplices.set(where, seen);
    if (seen > 1) {
      throw new ChangesetError(
        `${op.file}: only one entry may be spliced in or out per changeset; send the next separately`,
      );
    }
  }
}

/**
 * The array container and index an insert names a position in, or `null` for
 * an append or an object key. Read from the same `rowMatch` the safety check
 * used, never a second parse.
 */
function arrayPosition(op: FileOp) {
  const row = rowMatch(op.file, op.pointer, op.kind);
  if (row === null || row.register.shape !== 'array') return null;
  if (row.token === ARRAY_APPEND_TOKEN) return null;
  return { container: row.container, index: Number(row.token) };
}

/**
 * Which register a pointer names one row of, or null. A row is exactly one
 * reference token past the container: an index (or `-` on an insert) for an
 * array, an asset id for an object. `/assets/example.com/gsc` is an edit to a
 * lane, not a row, and matches nothing here.
 */
function rowMatch(file: string, pointer: string, kind: string) {
  if (typeof pointer !== 'string') return null;
  for (const [key, register] of registersForFile(file)) {
    const m = containerRegExp(register).exec(pointer);
    if (m === null) continue;
    const tail = pointer.slice(m[0].length);
    if (!tail.startsWith('/')) continue;
    const token = tail.slice(1);
    if (token.includes('/')) continue;
    const legal =
      register.shape === 'array' && kind === 'file-json-insert'
        ? token === ARRAY_APPEND_TOKEN || (positionedInsert(register) && isRowToken(register, token))
        : isRowToken(register, token);
    if (legal) return { key, register, token, container: m[0] };
  }
  return null;
}

/** The rows of an addable container, judged whole. */
function containerRefusal(match: Pick<RegisterMatch, 'key' | 'register'>, value: unknown): string | null {
  if (match.key === 'product-use-stages') return productUseStagesRefusal(value);
  if (!Array.isArray(value)) return 'The declared list must be an array';
  for (const row of value) {
    const refusal = rowRefusal(match.register, row);
    if (refusal !== null) return refusal;
  }
  return null;
}

/**
 * Where a `file-json-set` may write, in this order: a declared field of a
 * register's row (validated by the field; `readOnly` refused outright), a
 * declared knob (exact pointer only), anywhere in a wholesale-editable file,
 * or refused naming what it could have been instead.
 */
function validateSetTarget(at: string, op: FileJsonSetOp): void {
  const match = matchRegister(op.file, op.pointer);
  const register = match?.register ?? null;

  // A first write is the only set that may leave a key behind that was not
  // there when it started, so it is licensed before anything else.
  if (expectsAbsent(op)) {
    const refusal = firstWriteRefusal(match, op);
    if (refusal !== null) {
      throw new ChangesetError(`${at}: ${op.file} ${op.pointer} — ${refusal}`);
    }
  }

  if (register?.addableContainer === true && match!.rest.length === 0) {
    const refusal = containerRefusal(match!, op.value);
    if (refusal !== null) throw new ChangesetError(`${at}: ${refusal}`);
    return;
  }

  if (register?.fields) {
    const [rowToken, fieldName, ...deeper] = match!.rest;
    if (rowToken !== undefined && isRowToken(register, rowToken) && deeper.length === 0) {
      // The row itself, validated whole and guarded by the previous row as
      // `expect`.
      if (fieldName === undefined) {
        const refusal =
          rowRefusal(register, op.value) ?? readOnlyRowRefusal(register, op.expect as JsonValue, op.value);
        if (refusal !== null) {
          throw new ChangesetError(`${at}: ${op.file} ${op.pointer} — ${refusal}`);
        }
        return;
      }
      const field = fieldOf(register, fieldName);
      if (field !== null) {
        // Refused here and not only in the browser: a hand-written rename
        // changeset comes through this door too.
        const refusal = readOnlyFieldRefusal(field) ?? fieldRefusal(field, op.value);
        if (refusal !== null) {
          throw new ChangesetError(`${at}: ${op.file} ${op.pointer} — ${refusal}`);
        }
        return;
      }
    }
  }

  const knob = matchKnob(op.file, op.pointer);
  if (knob !== null) {
    const refusal = fieldRefusal(knob.knob.field, op.value);
    if (refusal !== null) {
      throw new ChangesetError(`${at}: ${op.file} ${op.pointer} — ${refusal}`);
    }
    return;
  }

  if (ALLOWED_FILES.has(op.file)) return;

  if (register?.fields) {
    throw new ChangesetError(
      `${at}: pointer ${JSON.stringify(op.pointer)} is not a declared field in ${op.file} — ` +
        `${register.container}/<row>/<field>, where <field> is one of ` +
        `${register.fields.map((f) => f.name).join(', ')} (${register.describe})`,
    );
  }
  // A file that declares knobs answers with them.
  const knobs = knobsForFile(op.file);
  if (knobs.length > 0) {
    throw new ChangesetError(
      `${at}: pointer ${JSON.stringify(op.pointer)} is not a settable knob in ${op.file} — ` +
        `the declared knobs are ${knobs.map(([, k]) => `${k.pointer} (${k.field.describe})`).join(', ')}`,
    );
  }
  throw new ChangesetError(
    `${at}: file ${JSON.stringify(op.file)} is not editable — the allowlist is ${[...ALLOWED_FILES].join(', ')}`,
  );
}

/**
 * Where a first write (`expectAbsent`) may land: a declared optional field of
 * a row that is already there, or a declared document at its own exact
 * pointer. Nothing else: the row is not born here, no parent is invented, an
 * array index is not a key, and a required field is not licensed (a row
 * missing one is broken, not blank).
 */
function firstWriteRefusal(match: RegisterMatch | null, op: FileJsonSetOp): string | null {
  if (optionalField(match) !== null) return null;
  if (declaredDocument(op.file, op.pointer)) return null;
  return '"expectAbsent" opens only a declared OPTIONAL field or document; add a row with file-json-insert';
}

/**
 * One declared optional field of a row that is already there, or null. One
 * predicate for both the `expectAbsent` set that writes the key and the
 * `file-json-delete` that takes it away, so whatever a first save may create
 * an undo may remove.
 */
function optionalField(match: RegisterMatch | null) {
  const register = match?.register ?? null;
  if (!register?.fields) return null;
  const [rowToken, fieldName, ...deeper] = match!.rest;
  if (rowToken === undefined || fieldName === undefined || deeper.length > 0) return null;
  if (!isRowToken(register, rowToken)) return null;
  const field = fieldOf(register, fieldName);
  return field !== null && field.required !== true ? field : null;
}

/**
 * The safety check for `file-json-insert` / `file-json-delete`, the only ops
 * that change a config file's shape: does some register name this exact row,
 * and is the value shaped like one of its rows. A delete has one more legal
 * pointer than an insert — a declared optional field of an existing row, the
 * mirror of the `expectAbsent` set that wrote it; a field's first value is a
 * set, so an insert has nothing to do there.
 */
function validateAddRemove(at: string, op: FileJsonInsertOp | FileJsonDeleteOp): void {
  // A retired key leaves by a delete, guarded like any other. Delete only.
  if (op.kind === 'file-json-delete' && typeof op.pointer === 'string' && retiredKey(op.file, op.pointer)) {
    validateDeleteGuard(at, op);
    return;
  }
  const registers = registersForFile(op.file);
  const document = declaredDocument(op.file, op.pointer);
  if (!document && registers.length === 0) {
    throw new ChangesetError(
      `${at}: ${JSON.stringify(op.kind)} may not touch ${JSON.stringify(op.file)} — ` +
        `the registers are in ${registerFiles().join(', ')}`,
    );
  }
  if (typeof op.pointer !== 'string' || !op.pointer.startsWith('/')) {
    throw new ChangesetError(
      `${at}: pointer must be an RFC 6901 JSON Pointer, got ${JSON.stringify(op.pointer)}`,
    );
  }

  if (document) {
    if (op.kind === 'file-json-insert') {
      if (!('value' in op)) throw new ChangesetError(`${at}: missing "value"`);
      if ('expect' in op) {
        throw new ChangesetError(
          `${at}: file-json-insert takes no "expect" — its guard is fixed at "nothing is there yet"`,
        );
      }
      const match = matchRegister(op.file, op.pointer);
      if (match?.register.addableContainer === true) {
        const refusal = containerRefusal(match, op.value);
        if (refusal !== null) throw new ChangesetError(`${at}: ${refusal}`);
      }
      return;
    }
    validateDeleteGuard(at, op);
    return;
  }

  // The field a first write created, taken away again. Delete only.
  if (op.kind === 'file-json-delete' && optionalField(matchRegister(op.file, op.pointer)) !== null) {
    validateDeleteGuard(at, op);
    return;
  }

  const row = rowMatch(op.file, op.pointer, op.kind);
  if (row === null) {
    const legal = registers
      .map(([, register]) => `${legalRowPointer(register, op.kind)} (${register.describe})`)
      .join(' or ');
    throw new ChangesetError(
      `${at}: ${JSON.stringify(op.pointer)} is not a row of ${op.file}; pointer must be ${legal}` +
        (op.kind === 'file-json-delete' ? ', or a declared OPTIONAL field' : ''),
    );
  }
  const { register } = row;

  if (op.kind === 'file-json-insert') {
    if (!('value' in op)) throw new ChangesetError(`${at}: missing "value"`);
    const refusal = rowRefusal(register, op.value);
    if (refusal !== null) throw new ChangesetError(`${at}: ${refusal}`);
    // An entry in an opaque array register carries its own key, or nothing
    // could ever address it for removal.
    if (
      register.fields === null &&
      register.shape === 'array' &&
      register.keyField != null &&
      !ASSET_ID_RE.test(String((op.value as Record<string, JsonValue>)[register.keyField] ?? ''))
    ) {
      throw new ChangesetError(
        `${at}: an entry appended to ${op.file} needs an "${register.keyField}" id`,
      );
    }
    // The guard on an insert is fixed at absence.
    if ('expect' in op) {
      throw new ChangesetError(
        `${at}: file-json-insert takes no "expect" — its guard is fixed at "nothing is there yet"`,
      );
    }
    return;
  }

  validateDeleteGuard(at, op);
}

/** What a `file-json-delete` must carry, wherever it is licensed: the value
 * it believes it is removing, and no `value` of its own. */
function validateDeleteGuard(at: string, op: FileJsonInsertOp | FileJsonDeleteOp): void {
  if (!('expect' in op)) {
    throw new ChangesetError(
      `${at}: missing "expect" — a delete must name the value it believes it is removing`,
    );
  }
  if ('value' in op) {
    throw new ChangesetError(`${at}: file-json-delete takes no "value"`);
  }
}

/**
 * An `asset-id` field has to name an asset that exists. `fieldRefusal` judges
 * shape only, so a typo'd id would book a cost against an asset no row has.
 * The candidates come from the roster register (`config/integrations.json`
 * `/assets`), not the `assets` table, which this module cannot reach — so the
 * check is deliberately weaker than the browser's, never stricter: it catches
 * the id that is in neither. Absent or empty roster refuses nothing.
 */
function unknownAssetRefusal(op: FileJsonSetOp | FileJsonInsertOp, candidates: string[] | null): string | null {
  if (op.kind !== 'file-json-set' && op.kind !== 'file-json-insert') return null;
  const match = matchRegister(op.file, op.pointer);
  const register = match?.register ?? null;
  if (register === null || register.fields === null) return null;
  const fields = assetIdFields(register);
  if (fields.length === 0) return null;
  const [rowToken, fieldName, ...deeper] = match!.rest;
  if (rowToken === undefined || deeper.length > 0) return null;
  // A whole row: every insert, and a set replacing a row rather than a field.
  if (fieldName === undefined) {
    const values = rowValue(register, op.value);
    for (const field of fields) {
      const refusal = candidateRefusal(field, candidates, values[field.name]);
      if (refusal !== null) return refusal;
    }
    return null;
  }
  if (!isRowToken(register, rowToken)) return null;
  const field = fields.find((f) => f.name === fieldName);
  return field === undefined ? null : candidateRefusal(field, candidates, op.value);
}

/**
 * A roster row may only be turned on when the asset has a live search lane
 * (`requiresLiveSearchLane`; the facts are `config/integrations.json`
 * `/assets/<asset>`). The register is keyed by asset id, so the row token is
 * the asset.
 */
function rosterRefusal(op: FileJsonSetOp | FileJsonInsertOp, match: RegisterMatch, lanes: Record<string, string> | null): string | null {
  const { register, rest } = match;
  if (register.requiresLiveSearchLane !== true) return null;
  const [rowToken, fieldName, ...deeper] = rest;
  if (rowToken === undefined || deeper.length > 0) return null;
  if (!isRowToken(register, rowToken)) return null;
  const enabled = fieldOf(register, 'enabled');
  if (enabled === null) return null;
  const value =
    fieldName === undefined
      ? rowValue(register, op.value)[enabled.name]
      : fieldName === enabled.name
        ? op.value
        : undefined;
  if (value === undefined) return null;
  return liveSearchLaneRefusal(enabled, lanes, value);
}

/**
 * One cluster, one spelling (`clusterField`). The only fact it needs is the
 * list the op writes into. The row being written is excluded from the
 * comparison, so recasing a cluster only one row uses is allowed.
 */
function clusterRefusal(op: FileJsonSetOp | FileJsonInsertOp, match: RegisterMatch, rows: JsonValue[]): string | null {
  const { register, rest } = match;
  const cluster = fieldOf(register, register.clusterField!);
  if (cluster === null) return null;
  const [rowToken, fieldName, ...deeper] = rest;
  if (rowToken === undefined || deeper.length > 0) return null;

  // One field of one row.
  if (fieldName !== undefined) {
    if (fieldName !== cluster.name || !isRowToken(register, rowToken)) return null;
    return clusterSpellingRefusal(register, rows, rowToken, cluster, op.value);
  }

  // A whole row: an append, or a set replacing the row at that index.
  const appending = op.kind === 'file-json-insert' && rowToken === ARRAY_APPEND_TOKEN;
  if (!appending && !isRowToken(register, rowToken)) return null;
  return clusterSpellingRefusal(
    register,
    rows,
    appending ? null : rowToken,
    cluster,
    rowValue(register, op.value)[cluster.name],
  );
}

/**
 * The first thing wrong with a whole config document, naming where, or null.
 * A document that arrives whole (a Worker's compiled-in default) never passed
 * through an op, so this walks it with the same declarations a Save is judged
 * by. A list at the top of the document must be there, in its declared
 * shape; a list inside one site's entry may be absent ("not declared").
 */
export function documentRefusal(file: string, doc: unknown): string | null {
  const registers = registersForFile(file);
  const isObject = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const rootIsList = registers.some(([, register]) => register.container === '' && register.shape === 'array');
  if (rootIsList ? !Array.isArray(doc) : !isObject(doc)) {
    return `the document must be a JSON ${rootIsList ? 'array' : 'object'}`;
  }
  for (const [key, register] of registers) {
    // A per-site container is one list per entry of the site map above it.
    const [holder, below] = register.container.split(`/${ASSET_PARAM}`) as [string, string | undefined];
    const sites = below === undefined ? null : pointerGet(doc, holder);
    const containers =
      below === undefined
        ? [holder]
        : isObject(sites)
          ? Object.keys(sites as object).map((site) => `${holder}/${site}${below}`)
          : [];
    for (const container of containers) {
      const rows = pointerGet(doc, container);
      if (rows === MISSING) {
        if (below === undefined) return `${container} is missing (${register.describe})`;
        continue;
      }
      if (register.shape === 'array' ? !Array.isArray(rows) : !isObject(rows)) {
        return `${container || 'the document'} must be a JSON ${register.shape} (${register.describe})`;
      }
      if (register.addableContainer === true) {
        const refusal = containerRefusal({ register, key }, rows);
        if (refusal !== null) return `${container} — ${refusal}`;
      }
      const entries: [string, unknown][] = Array.isArray(rows)
        ? rows.map((row, index) => [String(index), row])
        : Object.entries(rows as object);
      for (const [token, row] of entries) {
        if (!isRowToken(register, token)) return `${container}/${token} is not a valid key (${register.describe})`;
        const refusal = rowRefusal(register, row);
        if (refusal !== null) return `${container}/${token} — ${refusal}`;
      }
    }
  }
  for (const [, knob] of knobsForFile(file)) {
    const value = pointerGet(doc, knob.pointer);
    const refusal = fieldRefusal(knob.field, value === MISSING ? undefined : value);
    if (refusal !== null) return `${knob.pointer} — ${refusal}`;
  }
  return null;
}

/**
 * Resolve every op against current reality and collect all expect
 * mismatches. Nothing is written here; a changeset with one mismatch applies
 * none of its ops, in every entry point.
 *
 * `readDocument(file)` gives back the parsed document a repo-relative path
 * names, or throws. Each document is read at most once and handed back in
 * `documents`, which `applyDocumentOps` mutates. `readBuiltIn(file)` is the
 * copy a door's readers fall back to, which a key the saved document lacks
 * is compared with (`shownValue`); a built-in copy that cannot be read is no
 * built-in copy.
 */
export async function resolveOps(cs: Changeset, store: StoreLane | null, { readDocument, readBuiltIn }: { readDocument: DocumentReader; readBuiltIn?: DocumentReader }): Promise<{ resolved: Resolved[]; mismatches: Mismatch[]; documents: Map<string, unknown> }> {
  const documents = new Map<string, unknown>(); // relPath -> parsed JSON (read once, mutated at apply)
  const resolved: Resolved[] = [];
  const mismatches: Mismatch[] = [];

  const builtIns = new Map<string, unknown>(); // relPath -> the door's built-in copy, never mutated
  async function builtIn(rel: string) {
    if (!builtIns.has(rel)) {
      let doc: unknown = null;
      try {
        doc = readBuiltIn ? ((await readBuiltIn(rel)) ?? null) : null;
      } catch {
        doc = null;
      }
      builtIns.set(rel, doc);
    }
    return builtIns.get(rel);
  }

  async function loadDocument(rel: string) {
    if (documents.has(rel)) return documents.get(rel);
    let doc;
    try {
      doc = await readDocument(rel);
    } catch (err) {
      if (err instanceof ChangesetError) throw err;
      throw new ChangesetError(`could not read/parse ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (doc === null || doc === undefined) {
      throw new ChangesetError(`could not read/parse ${rel}: nothing holds that document`);
    }
    documents.set(rel, doc);
    return doc;
  }

  /** The roster document, read at most once. An install without it answers
   * `null`, and every rule reading it then refuses nothing. */
  let rosterDoc: unknown;
  async function roster() {
    if (rosterDoc !== undefined) return rosterDoc;
    try {
      rosterDoc = (await readDocument(assetRosterFile())) ?? null;
    } catch {
      rosterDoc = null;
    }
    return rosterDoc;
  }
  /** The asset ids it declares. */
  async function rosterIds() {
    return rosterAssetIds(await roster());
  }
  /** One asset's lane statuses out of it, as `laneStatuses` shapes them. */
  async function lanesOf(asset: string) {
    const doc = await roster();
    const assets = doc === null || typeof doc !== 'object' ? undefined : (doc as Record<string, unknown>).assets;
    if (assets === null || assets === undefined || typeof assets !== 'object') return null;
    return laneStatuses((assets as Record<string, unknown>)[asset]);
  }

  cs.ops.forEach((op) => {
    resolved.push({ op, current: MISSING });
  });

  for (const r of resolved) {
    const { op } = r;
    if (op.kind === 'file-json-set' || op.kind === 'file-json-insert') {
      const refusal = unknownAssetRefusal(op, await rosterIds());
      if (refusal !== null) {
        throw new ChangesetError(`${op.file} ${op.pointer} — ${refusal}`);
      }
      const match = matchRegister(op.file, op.pointer);
      if (match?.register.requiresLiveSearchLane === true) {
        const laneRule = rosterRefusal(op, match, await lanesOf(match.rest[0]!));
        if (laneRule !== null) {
          throw new ChangesetError(`${op.file} ${op.pointer} — ${laneRule}`);
        }
      }
      if (match?.register.clusterField !== undefined) {
        const rows = pointerGet(await loadDocument(op.file), match.container);
        const spelling = clusterRefusal(op, match, Array.isArray(rows) ? rows : []);
        if (spelling !== null) {
          throw new ChangesetError(`${op.file} ${op.pointer} — ${spelling}`);
        }
      }
    }
    if (op.kind === 'file-json-set' || op.kind === 'file-json-delete') {
      const doc = await loadDocument(op.file);
      const saved = pointerGet(doc, op.pointer);
      // A set is compared with what the page showed; a delete removes only
      // what is saved.
      const shown = op.kind === 'file-json-set' ? await shownValue(op, saved, builtIn) : saved;
      r.current = readsAsUnsaved(op.file, op.pointer, shown);
      if (saved === MISSING && r.current !== MISSING) r.builtIn = true;
      // A first write guards on absence, so the comparison below is the
      // ordinary one: a field somebody else filled in reports as a mismatch
      // beside every other stale op.
      if (expectsAbsent(op)) r.expect = MISSING;
      else if (op.kind === 'file-json-set' && op.expect !== undefined) r.expect = readsAsUnsaved(op.file, op.pointer, op.expect);
    } else if (op.kind === 'file-json-insert') {
      // An insert's guard is that nothing is there, so its `expect` is MISSING
      // and a taken key reports as an ordinary mismatch.
      const doc = await loadDocument(op.file);
      const at = arrayPosition(op);
      if (at === null) {
        r.current = readsAsUnsaved(op.file, op.pointer, pointerGet(doc, op.pointer));
        r.expect = MISSING;
      } else {
        // An indexed array insert shifts rather than fills a hole, so the
        // question is whether the index is a position in this list; past the
        // end is refused rather than quietly appended.
        const rows = pointerGet(doc, at.container);
        const length = Array.isArray(rows) ? rows.length : -1;
        if (at.index > length) {
          throw new ChangesetError(
            `${op.file} ${op.pointer}: nothing to insert before — ` +
              `${at.container} holds ${length < 0 ? 'no list' : `${length} entr${length === 1 ? 'y' : 'ies'}`}`,
          );
        }
        r.current = MISSING;
        r.expect = MISSING;
      }
    } else {
      if (!store) {
        throw new ChangesetError(
          `op names the store (${op.asset}.${op.column}); write store columns through PATCH /api/assets/:id`,
        );
      }
      r.current = await store.column(op.asset, op.column);
    }
    const expect = ('expect' in r ? r.expect : 'expect' in op ? op.expect : MISSING) as JsonValue | typeof MISSING;
    if (!deepEqual(r.current, expect)) {
      mismatches.push({ op, current: r.current, expect });
    }
  }

  return { resolved, mismatches, documents };
}

// Apply the document half: mutate the parsed documents in place and say which
// ones changed. Persisting them, and the store half, is the caller's.
export function applyDocumentOps(resolved: Resolved[], documents: Map<string, unknown>, { at }: { at?: string } = {}): string[] {
  const touched = new Set<string>();
  const stageLists = new Map<string, Set<string>>();
  for (const r of resolved) {
    const { op } = r;
    if (op.kind !== 'store-asset-set') {
      const match = matchRegister(op.file, op.pointer);
      const container = match?.key === 'product-use-stages' ? match.container
        : match?.key === 'value-events-assets' && match.rest.length === 1
          ? `${op.pointer}/productUseStages` : null;
      if (container !== null) {
        const lists = stageLists.get(op.file) ?? new Set<string>();
        lists.add(container); stageLists.set(op.file, lists);
      }
    }
    if (op.kind === 'file-json-set') {
      // The one set that may leave behind a key that was not there: the field
      // or document whose absence this op's guard just proved, or the key it
      // saved for the first time over the built-in copy's value.
      const doc = documents.get(op.file);
      if (r.builtIn === true) createParents(doc, op.pointer);
      pointerSet(doc, op.pointer, op.value, { create: expectsAbsent(op) || r.expect === MISSING || r.builtIn === true });
    } else if (op.kind === 'file-json-insert') {
      const doc = documents.get(op.file);
      // A declared document spelled `null` is one nobody has saved
      // (`readsAsUnsaved`), so an insert fills that key rather than refusing to
      // overwrite it.
      if (declaredDocument(op.file, op.pointer) && pointerGet(doc, op.pointer) === null) {
        pointerSet(doc, op.pointer, op.value);
      } else {
        pointerInsert(doc, op.pointer, op.value);
      }
    } else if (op.kind === 'file-json-delete') {
      pointerDelete(documents.get(op.file), op.pointer);
    } else {
      continue;
    }
    touched.add(op.file);
  }
  // A row/field can be valid on its own while breaking uniqueness, the list
  // bound or a comparison. Judge the FINAL batch before any caller persists it;
  // a valid rename batch and deletion of malformed stored rows can recover.
  for (const [file, containers] of stageLists) {
    for (const container of containers) {
      const value = pointerGet(documents.get(file), container);
      if (value === MISSING) continue; // List Undo or holder deletion.
      const refusal = productUseStagesRefusal(value);
      if (refusal !== null) throw new ChangesetError(`${file} ${container} — ${refusal}`);
    }
  }
  const date = applyDate(at);
  stampRows(resolved, documents, date);
  stampDocuments(touched, documents, date);
  return [...touched];
}

/**
 * The day a changeset is applied, as a config file spells a date. `at` is the
 * changeset's own `createdAt` wherever a caller has one, so the stamp, the
 * archived changeset and the `config_changes` row name the same instant. UTC,
 * like every other date this repo writes down.
 */
function applyDate(at: string | null | undefined): string {
  const ms = at === undefined || at === null ? Date.now() : Date.parse(at);
  return new Date(Number.isNaN(ms) ? Date.now() : ms).toISOString().slice(0, 10);
}

/**
 * Apply a register's `stamps`. Only a `file-json-set` that changes the watched
 * field counts: an insert supplies its own date, a delete has no row left,
 * and re-saving the same value decided nothing. Both spellings of a set are
 * handled (the field alone, or the whole row). An undo re-stamps to the day
 * of the undo, which is when that decision was taken. Refreshes and never
 * invents: a row whose optional date was never written does not gain one.
 */
function stampRows(resolved: Resolved[], documents: Map<string, unknown>, date: string): void {
  for (const r of resolved) {
    const { op } = r;
    if (op.kind !== 'file-json-set') continue;
    const match = matchRegister(op.file, op.pointer);
    if (match === null) continue;
    const stamps = registerStamps(match.register);
    if (stamps.length === 0) continue;
    const [rowToken, fieldName, ...deeper] = match!.rest;
    if (rowToken === undefined || deeper.length > 0) continue;
    if (!isRowToken(match.register, rowToken)) continue;
    for (const stamp of stamps) {
      const [before, after] =
        fieldName === undefined
          ? [rowValue(match.register, r.current === MISSING ? null : r.current)[stamp.when], rowValue(match.register, op.value)[stamp.when]]
          : fieldName === stamp.when
            ? [r.current, op.value]
            : [undefined, undefined];
      if (before === undefined && after === undefined) continue;
      if (deepEqual(before, after)) continue;
      const pointer = `${match.container}/${rowToken}/${stamp.field}`;
      const doc = documents.get(op.file);
      if (pointerGet(doc, pointer) === MISSING) continue;
      pointerSet(doc, pointer, date);
    }
  }
}

/**
 * Refresh the date a file states about itself (`DOCUMENT_STAMPS`). Runs here
 * so every entry point gives one answer. An absent pointer stays absent.
 */
function stampDocuments(touched: Set<string>, documents: Map<string, unknown>, date: string): void {
  for (const rel of touched) {
    const pointer = documentStamp(rel);
    if (pointer === null) continue;
    const doc = documents.get(rel);
    if (pointerGet(doc, pointer) === MISSING) continue;
    pointerSet(doc, pointer, date);
  }
}

/**
 * How a config document is serialized everywhere it is written, so an export
 * and a save cannot produce two byte-different spellings of one document.
 */
export function serializeDocument(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + '\n';
}
