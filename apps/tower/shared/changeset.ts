// The changeset contract — the exact document both entry points apply: the
// Tower's write lane (apps/tower/vite/config-write-lane.ts) and
// `pnpm config:apply` (scripts/config-apply.mjs). This module mints the
// document; applying is scripts/config-apply-core.mjs. The format's prose
// spec is config/changesets/README.md — keep them in lockstep.

import type * as Configuration from '@noticeos/contract/configuration';
import type { JsonValue, StoreColumn } from '@noticeos/contract/configuration';
export type { JsonValue, StoreColumn } from '@noticeos/contract/configuration';
export { ASSET_STATUSES as ASSET_STATUS } from '@noticeos/contract/configuration';
export type AssetStatusValue = Configuration.AssetStatus;

/** The files a changeset may SET a value in (mirrors the shared safety
 * allowlist, `ALLOWED_FILES`). */
export type EditableFile =
  | "config/constants.json"
  | "config/pull.json"
  | "config/integrations.json"
  | "config/tower.json";

/** The files whose per-asset register may grow or shrink by one entry — a
 * narrower permission than editing a value, and a separate allowlist for it
 * (`ADDABLE_CONTAINERS`). Adding an asset's counter block, panel-roster row
 * or tracked-query panel is allowed; rewriting one is not. An asset's own
 * GA4 declarations are part of what the asset is, so they leave with it;
 * neither is written on Create. */
export type AssetRegisterFile =
  | "config/integrations.json"
  | "config/counters.json"
  | "config/pull.json"
  | "config/signal-panels.json"
  | "config/serp-panel.json"
  | "config/value-events.json"
  | "config/ga4-custom-dimensions.json";

/**
 * Every file holding a declared register — a container whose rows may be
 * added and removed, and whose declared fields may be set. The declaration
 * itself is `scripts/config-registers.mjs`, read by this app through
 * `shared/config-registers.ts`; this union is only the file names.
 */
export type RegisterFile =
  | AssetRegisterFile
  | "config/domain-costs.json"
  | "config/recurring-costs.json"
  | "config/beads.json"
  // Not an `AssetRegisterFile`: an asset is not born into it. The add adds
  // the new id to the entity's own list, a set on a row already there, and a
  // delete takes it back off as one guarded set in the delete's changeset.
  | "config/entities.json";

/** The files holding a declared document — one whole optional block, at one
 * exact pointer, that may be added and removed but never grown into
 * (`ADDABLE_DOCUMENTS` in `scripts/config-documents.mjs`): the Wall's saved
 * layout at `/wall`, and the countdown at `/countdown`. */
export type DocumentFile = "config/tower.json" | "config/constants.json";

// UI permissions narrow the portable operation vocabulary to declared files.
export type FileJsonSetOp = Configuration.FileJsonSetOp<EditableFile | RegisterFile>;
export type FileJsonSetGuardedOp = Configuration.FileJsonSetGuardedOp<EditableFile | RegisterFile>;
export type FileJsonSetFirstOp = Configuration.FileJsonSetFirstOp<EditableFile | RegisterFile>;
export type FileJsonInsertOp = Configuration.FileJsonInsertOp<RegisterFile | DocumentFile>;
export type FileJsonDeleteOp = Configuration.FileJsonDeleteOp<RegisterFile | DocumentFile>;
export type StoreAssetSetOp = Configuration.StoreAssetSetOp<StoreColumn>;

export type ChangesetOp =
  | FileJsonSetOp
  | FileJsonInsertOp
  | FileJsonDeleteOp
  | StoreAssetSetOp;

/** Everything the write lane applies — the store column is the Worker's. */
export type FileOp = FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;

/**
 * The ops a setting save is made of — every one of them invertible, which is
 * what makes the Undo in the toast honest. Two invert by swapping `expect`
 * and `value`; a first write and a {@link FileJsonDeleteOp} at the field's
 * own pointer invert into each other. Adding or removing an asset's whole
 * entry is structural rather than a setting, so `useConfigSave` does not take
 * those.
 */
export type SettingOp = FileJsonSetOp | FileJsonDeleteOp | StoreAssetSetOp;

export type Changeset = Configuration.Changeset<ChangesetOp>;

// ---------------------------------------------------------------------------
// RFC 6901 JSON Pointer — resolve (read) only. Writing a pointer is the shared
// pipeline's job (scripts/config-apply-core.mjs); the browser only ever needs to
// READ a current value to compute `expect`.
// ---------------------------------------------------------------------------
function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Escape one object key / array-index into a pointer reference token. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Build a pointer from segments, e.g. ["flag_defaults","alpha"] → "/flag_defaults/alpha". */
export function toPointer(segments: (string | number)[]): string {
  return segments.map((s) => "/" + escapePointerToken(String(s))).join("");
}

/** Resolve a pointer against a parsed JSON value; `undefined` if any segment is
 * absent (distinct from a present `null`). Empty pointer → the whole document. */
export function resolvePointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) return undefined;
  const tokens = pointer.slice(1).split("/").map(unescapeToken);
  let cur: JsonValue | undefined = doc;
  for (const tok of tokens) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(tok)) return undefined;
      const i = Number(tok);
      if (i >= cur.length) return undefined;
      cur = cur[i];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return undefined;
      cur = (cur as { [k: string]: JsonValue })[tok];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Serializer — the one place a Changeset document is minted.
// ---------------------------------------------------------------------------
export interface BuildChangesetOptions {
  slug?: string;
  createdAt?: string;
}

/**
 * A slug the pipeline will accept, built out of words the surface already
 * has. `validateSchemaAndSafety` requires kebab-case, and an asset id is
 * domain-shaped while a declared field is camelCase. Readable rather than
 * hashed, because a slug is the archived changeset's filename and the commit
 * subject (`example-com-ga4-property-id` still says what was saved and
 * where).
 */
export function changesetSlug(...parts: (string | number)[]): string {
  const slug = parts
    .map((part) => String(part).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Parts that were all punctuation get the write lane's own default rather
  // than a slug the pipeline would refuse.
  return slug === "" ? "config-change" : slug;
}

/** A kebab default slug: `tower-YYYYMMDD-HHMMSS` (stable, filename-safe). */
export function defaultSlug(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `tower-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
}

/** Serialize ops into the version-1 changeset document both lanes consume. */
export function buildChangeset(ops: ChangesetOp[], options: BuildChangesetOptions = {}): Changeset {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const slug = options.slug ?? defaultSlug(new Date(createdAt));
  return { version: 1, createdAt, slug, ops };
}
