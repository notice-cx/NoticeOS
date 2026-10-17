// Where each site shows: a row on Home and on the Sites page (`list`), every
// widget on the TV (`tv`), and a row in the TV's Work this week (`work`). The
// switches the operator set are stored in `config/tower.json` at `/sites`
// (the `site-display` register in scripts/config-registers.mts). A switch
// nobody set follows the site's stage, so a retired site shows nowhere until a
// switch is turned on, and a stage move never rewrites a switch somebody set.
// `siteShownOn` is the one reading every screen uses; `shownOnChange` is the
// one write that flips one switch, with its exact way back.

import { isRetired } from "./asset-setup";
import type { FileJsonDeleteOp, FileJsonInsertOp, FileJsonSetOp, JsonValue } from "./changeset";
import { toPointer } from "./changeset";

export const SITE_DISPLAY_FILE = "config/tower.json";
export const SITE_DISPLAY_POINTER = "/sites";

/** The three switches, in the order every screen draws them. */
export const SHOWN_ON = ["list", "tv", "work"] as const;
export type ShownOnSurface = (typeof SHOWN_ON)[number];
export type ShownOn = Record<ShownOnSurface, boolean>;

/** The switches the operator set, by site id, as stored. A missing site or
 * key is a switch nobody set. */
export type SiteDisplay = Readonly<Record<string, Readonly<Partial<ShownOn>>>>;

/** What each switch is called on every screen, and in the register. */
export const SHOWN_ON_LABEL: Readonly<Record<ShownOnSurface, string>> = {
  list: "Home and Sites list",
  tv: "TV",
  work: "Work this week",
};

/** The switches a wall read carries. A payload held from before they existed,
 * or a fixture built for another slice, carries no `dashboard` at all, and
 * reads as nothing set rather than taking the page down. */
export function siteDisplayOf(read: { dashboard?: { sites?: SiteDisplay } } | null | undefined): SiteDisplay | undefined {
  return read?.dashboard?.sites;
}

/** The fields a site needs for its switches to be read. */
export interface DisplayedSite {
  id: string;
  status: string;
}

/** What a switch nobody set reads as: on, except for a retired site. */
export function shownByDefault(status: string): boolean {
  return !isRetired(status);
}

/** Where a site shows: each switch as the operator set it, else its stage's
 * default. */
export function siteShownOn(site: DisplayedSite, display: SiteDisplay | null | undefined): ShownOn {
  const set = display?.[site.id];
  const fallback = shownByDefault(site.status);
  return {
    list: set?.list ?? fallback,
    tv: set?.tv ?? fallback,
    work: set?.work ?? fallback,
  };
}

/** Which switches of a site the operator set, rather than its stage. */
export function siteSwitchesSet(site: Pick<DisplayedSite, "id">, display: SiteDisplay | null | undefined): Readonly<Partial<Record<ShownOnSurface, true>>> {
  const set = display?.[site.id];
  const out: Partial<Record<ShownOnSurface, true>> = {};
  for (const surface of SHOWN_ON) if (set?.[surface] !== undefined) out[surface] = true;
  return out;
}

/** The sites shown on one surface, in the order given. */
export function sitesShownOn<T extends DisplayedSite>(
  sites: readonly T[],
  display: SiteDisplay | null | undefined,
  surface: ShownOnSurface,
): T[] {
  return sites.filter((site) => siteShownOn(site, display)[surface]);
}

/**
 * The stored `/sites` map, read whole: an object of sites, each an object
 * holding only the three switches as true or false. `undefined` for absent or
 * `null`, which is nothing saved yet; throws, naming what is wrong, for
 * anything else.
 */
export function readSiteDisplay(value: unknown): SiteDisplay | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config/tower.json sites, when present, must be an object");
  }
  const out: Record<string, Partial<ShownOn>> = {};
  for (const [site, row] of Object.entries(value as Record<string, unknown>)) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`config/tower.json sites.${site} must be an object`);
    }
    const switches: Partial<ShownOn> = {};
    for (const [key, on] of Object.entries(row as Record<string, unknown>)) {
      if (!(SHOWN_ON as readonly string[]).includes(key)) {
        throw new Error(`config/tower.json sites.${site}.${key} is not one of ${SHOWN_ON.join(", ")}`);
      }
      if (typeof on !== "boolean") throw new Error(`config/tower.json sites.${site}.${key} must be true or false`);
      switches[key as ShownOnSurface] = on;
    }
    out[site] = switches;
  }
  return out;
}

export type SiteDisplayOp = FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;

/** One switch flipped: the ops that write it and the ops that take it back. */
export interface ShownOnChange {
  ops: SiteDisplayOp[];
  undo: SiteDisplayOp[];
}

/**
 * Set one switch of one site, guarded by the map as the page read it. A
 * pointer never creates structure, so the write is whichever of four the
 * stored map needs: the whole map when none is saved, the site's row when it
 * has none, the key for the first time, or the key over its old value. Undo
 * is the exact reverse, guarded by what this write leaves.
 */
export function shownOnChange(
  display: SiteDisplay | null | undefined,
  site: string,
  surface: ShownOnSurface,
  on: boolean,
): ShownOnChange {
  const file = SITE_DISPLAY_FILE;
  if (display === undefined || display === null) {
    const value: JsonValue = { [site]: { [surface]: on } };
    return {
      ops: [{ kind: "file-json-insert", file, pointer: SITE_DISPLAY_POINTER, value }],
      undo: [{ kind: "file-json-delete", file, pointer: SITE_DISPLAY_POINTER, expect: value }],
    };
  }
  const row = display[site];
  const rowPointer = toPointer(["sites", site]);
  if (row === undefined) {
    const value: JsonValue = { [surface]: on };
    return {
      ops: [{ kind: "file-json-insert", file, pointer: rowPointer, value }],
      undo: [{ kind: "file-json-delete", file, pointer: rowPointer, expect: value }],
    };
  }
  const pointer = toPointer(["sites", site, surface]);
  const was = row[surface];
  if (was === undefined) {
    return {
      ops: [{ kind: "file-json-set", file, pointer, expectAbsent: true, value: on }],
      undo: [{ kind: "file-json-delete", file, pointer, expect: on }],
    };
  }
  return {
    ops: [{ kind: "file-json-set", file, pointer, expect: was, value: on }],
    undo: [{ kind: "file-json-set", file, pointer, expect: on, value: was }],
  };
}
