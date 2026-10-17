// Where each site shows: a row on Home and on the Sites page (`list`), every
// widget on the TV (`tv`), and a row in the TV's Work this week (`work`); and
// the icon addresses that replace the ones read from its pages (`lightIcon`,
// `darkIcon`). What the operator set is stored in `config/tower.json` at
// `/sites` (the `site-display` register in scripts/config-registers.mts). A
// switch nobody set follows the site's stage, so a retired site shows nowhere
// until a switch is turned on, and a stage move never rewrites a switch
// somebody set. `siteShownOn` is the one reading every screen uses;
// `siteDisplayChange` is the one write of one key, with its exact way back.

import { isRetired } from "./asset-setup";
import type { FileJsonDeleteOp, FileJsonInsertOp, FileJsonSetOp, JsonValue } from "./changeset";
import { toPointer } from "./changeset";
import { configRegister, fieldOf, fieldRefusal } from "./config-registers";

export const SITE_DISPLAY_FILE = "config/tower.json";
export const SITE_DISPLAY_POINTER = "/sites";

/** The three switches, in the order every screen draws them. */
export const SHOWN_ON = ["list", "tv", "work"] as const;
export type ShownOnSurface = (typeof SHOWN_ON)[number];
export type ShownOn = Record<ShownOnSurface, boolean>;

/** The two icon addresses, by the scheme of the screen each is drawn on. */
export const SITE_ICON_KEY = { light: "lightIcon", dark: "darkIcon" } as const;
export type SiteIconScheme = keyof typeof SITE_ICON_KEY;
export type SiteIconKey = (typeof SITE_ICON_KEY)[SiteIconScheme];
const SITE_ICON_KEYS: readonly string[] = Object.values(SITE_ICON_KEY);

/** One site's stored row: the switches and the icon addresses the operator
 * set. A missing key is one nobody set. */
export type SiteDisplayRow = Partial<ShownOn> & Partial<Record<SiteIconKey, string>>;

/** What the operator set, by site id, as stored. A missing site or key is
 * one nobody set. */
export type SiteDisplay = Readonly<Record<string, Readonly<SiteDisplayRow>>>;

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

/** The icon addresses the operator set for one site, by scheme. */
export function siteIconAddresses(display: SiteDisplay | null | undefined, site: string): Partial<Record<SiteIconScheme, string>> {
  const set = display?.[site];
  const out: Partial<Record<SiteIconScheme, string>> = {};
  if (set?.lightIcon !== undefined) out.light = set.lightIcon;
  if (set?.darkIcon !== undefined) out.dark = set.darkIcon;
  return out;
}

/**
 * The stored `/sites` map, read whole: an object of sites, each an object
 * holding only the three switches as true or false and the two icon
 * addresses, each judged by its register field. `undefined` for absent or
 * `null`, which is nothing saved yet; throws, naming what is wrong, for
 * anything else.
 */
export function readSiteDisplay(value: unknown): SiteDisplay | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config/tower.json sites, when present, must be an object");
  }
  const register = configRegister("site-display");
  const out: Record<string, SiteDisplayRow> = {};
  for (const [site, row] of Object.entries(value as Record<string, unknown>)) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`config/tower.json sites.${site} must be an object`);
    }
    const read: SiteDisplayRow = {};
    for (const [key, held] of Object.entries(row as Record<string, unknown>)) {
      if ((SHOWN_ON as readonly string[]).includes(key)) {
        if (typeof held !== "boolean") throw new Error(`config/tower.json sites.${site}.${key} must be true or false`);
        read[key as ShownOnSurface] = held;
      } else if (SITE_ICON_KEYS.includes(key)) {
        const refusal = fieldRefusal(fieldOf(register, key)!, held);
        if (refusal !== null || typeof held !== "string") throw new Error(`config/tower.json sites.${site}: ${refusal ?? `${key} must be a string`}`);
        read[key as SiteIconKey] = held;
      } else {
        throw new Error(`config/tower.json sites.${site}.${key} is not one of ${[...SHOWN_ON, ...SITE_ICON_KEYS].join(", ")}`);
      }
    }
    out[site] = read;
  }
  return out;
}

export type SiteDisplayOp = FileJsonSetOp | FileJsonInsertOp | FileJsonDeleteOp;

/** One key changed: the ops that write it and the ops that take it back. */
export interface SiteDisplayChange {
  ops: SiteDisplayOp[];
  undo: SiteDisplayOp[];
}

/** One switch flipped, as `siteDisplayChange` writes it. */
export type ShownOnChange = SiteDisplayChange;

type SiteDisplayKey = ShownOnSurface | SiteIconKey;

/**
 * Set or clear one key of one site, guarded by the map as the page read it. A
 * pointer never creates structure, so a set is whichever of four writes the
 * stored map needs: the whole map when none is saved, the site's row when it
 * has none, the key for the first time, or the key over its old value. A
 * clear (`null`) deletes the key and is no write at all when the key is not
 * there. Undo is the exact reverse, guarded by what this write leaves.
 */
export function siteDisplayChange(
  display: SiteDisplay | null | undefined,
  site: string,
  key: SiteDisplayKey,
  value: boolean | string | null,
): SiteDisplayChange {
  const file = SITE_DISPLAY_FILE;
  const row = display?.[site];
  const was: JsonValue | undefined = row?.[key];
  const pointer = toPointer(["sites", site, key]);
  if (value === null) {
    if (was === undefined) return { ops: [], undo: [] };
    return {
      ops: [{ kind: "file-json-delete", file, pointer, expect: was }],
      undo: [{ kind: "file-json-set", file, pointer, expectAbsent: true, value: was }],
    };
  }
  if (display === undefined || display === null) {
    const whole: JsonValue = { [site]: { [key]: value } };
    return {
      ops: [{ kind: "file-json-insert", file, pointer: SITE_DISPLAY_POINTER, value: whole }],
      undo: [{ kind: "file-json-delete", file, pointer: SITE_DISPLAY_POINTER, expect: whole }],
    };
  }
  if (row === undefined) {
    const rowPointer = toPointer(["sites", site]);
    const fresh: JsonValue = { [key]: value };
    return {
      ops: [{ kind: "file-json-insert", file, pointer: rowPointer, value: fresh }],
      undo: [{ kind: "file-json-delete", file, pointer: rowPointer, expect: fresh }],
    };
  }
  if (was === undefined) {
    return {
      ops: [{ kind: "file-json-set", file, pointer, expectAbsent: true, value }],
      undo: [{ kind: "file-json-delete", file, pointer, expect: value }],
    };
  }
  return {
    ops: [{ kind: "file-json-set", file, pointer, expect: was, value }],
    undo: [{ kind: "file-json-set", file, pointer, expect: value, value: was }],
  };
}

/** Set one switch of one site (`siteDisplayChange`). */
export function shownOnChange(
  display: SiteDisplay | null | undefined,
  site: string,
  surface: ShownOnSurface,
  on: boolean,
): ShownOnChange {
  return siteDisplayChange(display, site, surface, on);
}
