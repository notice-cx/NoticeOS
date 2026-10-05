// Shared CHANGESET contract — the exact document both entry points apply: the
// Tower's own write lane (apps/tower/vite/config-write-lane.ts) and the
// operator's `pnpm config:apply` (scripts/config-apply.mjs). Pure types + a tiny
// RFC-6901 resolver + a serializer; no runtime deps, so it is safe anywhere —
// browser, Worker, and the dev server's Node process.
//
// This module MINTS the document; it never applies one. Applying is the shared
// pipeline in scripts/config-apply-core.mjs, which owns the safety allowlist,
// the `expect` guard, the file write and the archive. The format's prose spec is
// config/changesets/README.md — keep them in lockstep.

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

/** The files whose per-asset register may GROW or SHRINK by one entry — a
 * narrower permission than editing a value, and a separate allowlist for it
 * (`ADDABLE_CONTAINERS`). The last three are here and NOT above: adding an
 * asset's counter block, panel-roster row or tracked-query panel is allowed,
 * rewriting one is not.
 *
 * `config/signal-panels.json` and `config/serp-panel.json` joined in bead
 * `ro-sk7q`. Both key by asset id, and while they were missing a delete removed
 * neither and the confirmation never named them — an asset could leave its id
 * behind in a file nothing would ever mention.
 *
 * `config/value-events.json` and `config/ga4-custom-dimensions.json` joined in
 * bead `ro-vyer` for the same reason, once the Sources tab could file an entry
 * in either with a click rather than a hand edit. An asset's own GA4
 * declarations are part of what the asset IS, so they leave with it — the
 * deliberate answer to the question `ro-sk7q`'s pinned key-set test exists to
 * force. Neither is written on Create: the wizard has nothing to declare yet,
 * and an entry holding `[]` is a claim nobody has made. */
export type AssetRegisterFile =
  | "config/integrations.json"
  | "config/counters.json"
  | "config/pull.json"
  | "config/signal-panels.json"
  | "config/serp-panel.json"
  | "config/value-events.json"
  | "config/ga4-custom-dimensions.json";

/**
 * Every file holding a declared REGISTER — a container whose rows may be added
 * and removed, and whose declared fields may be set (bead `ro-x5gu.1`).
 *
 * It is the seven WHOLE-ASSET registers above plus the list-shaped ones epic
 * `ro-x5gu` put a CRUD surface on. The two sets overlap heavily now:
 * `serp-panel.json`, `signal-panels.json`, `value-events.json` and
 * `ga4-custom-dimensions.json` are all both — an asset is born into or deleted
 * out of the whole entry (`ro-sk7q`, `ro-vyer`), and its Growth or Sources tab
 * edits the rows inside.
 *
 * The declaration itself — container, shape, key and per-field rules — is
 * `scripts/config-registers.mjs`, read by this app through
 * `shared/config-registers.ts` and by the write lane and the CLI directly; this
 * union is only the file names, kept here because it is what an op's `file`
 * field may say.
 */
export type RegisterFile =
  | AssetRegisterFile
  | "config/domain-costs.json"
  | "config/recurring-costs.json"
  | "config/beads.json"
  // The portfolio's legal entities and the assets each one owns (bead
  // `ro-aodz`). Not an `AssetRegisterFile`: an asset is not BORN into it — the
  // wizard adds the new id to the entity the operator picked, which is a set on
  // a row that is already there, and an entity outlives every asset it owns.
  // DELETING an asset takes its id back off that list for the same reason it was
  // never an entry: not through `ADDABLE_CONTAINERS`, but as one guarded set
  // beside the register deletes, in the delete's own changeset (bead `ro-xzxg`).
  | "config/entities.json";

/**
 * The files holding a declared DOCUMENT — one whole optional block, at one exact
 * pointer, that may be ADDED and REMOVED but never grown into (bead `ro-fqag`,
 * `ADDABLE_DOCUMENTS` in `scripts/config-documents.mjs`).
 *
 * A register is the wrong shape for these: a register is a list of rows keyed by
 * an asset, and these are one document at one pointer — the Wall's saved layout
 * at `/wall`, and the countdown at `/countdown`. Both exist because "we never
 * create structure" is the oldest rule here and a fresh install has neither, so
 * without this permission the product could edit a countdown it could never make.
 */
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
 * The ops a SETTING save is made of — every one of them invertible, which is
 * what makes the Undo in the toast honest (docs/15 principle 5).
 *
 * Two of them invert by swapping `expect` and `value`. The other two invert into
 * EACH OTHER (bead `ro-pkpz`): a first write puts a key there that was not
 * there, and the way back is taking that key away, which is a
 * {@link FileJsonDeleteOp} at the field's own pointer — and the way back from
 * THAT is the first write again. Until the pipeline licensed a delete at a
 * declared optional field there was no such op, so a first save carried no Undo
 * at all and a mapping was a one-way door.
 *
 * Adding or removing an asset's whole ENTRY is still structural rather than a
 * setting — its inverse is a different op kind at a pointer that has moved — so
 * `useConfigSave` does not take those, and the add-asset flow owns its own way
 * back (deleting the asset it just made).
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
 * A slug the pipeline will accept, built out of words the surface already has
 * (bead `ro-6ygn`).
 *
 * `validateSchemaAndSafety` requires kebab-case — `^[a-z0-9]+(?:-[a-z0-9]+)*$`
 * — and the words a per-asset surface has to hand are neither: an asset id is
 * domain-shaped (`example.com`) and a declared field is camelCase
 * (`propertyId`). Interpolating them straight into a slug refused every Save on
 * an asset's Sources tab with `422 invalid_changeset` and a sentence about a
 * slug the operator never typed — in front of the guard, so it refused the
 * mapping, the reason and the posture alike.
 *
 * It stays READABLE rather than hashed, because a slug is the archived
 * changeset's filename and the commit subject: the repo history shows
 * `myplate-food-ga4-property-id`, which still says what was saved and where.
 */
export function changesetSlug(...parts: (string | number)[]): string {
  const slug = parts
    .map((part) => String(part).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A caller whose parts were all punctuation gets the write lane's own default
  // rather than a slug the pipeline would refuse — a Save must not fail over its
  // filename.
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
