// Archived sites stay hidden regardless of saved switches. Restoring a site
// recovers its saved visibility preferences. The write that flips one switch is the narrowest the stored map
// allows, and its Undo is its exact reverse.

import { describe, expect, it } from "vitest";
import { ASSET_TYPES, assetTypeOf } from "@noticeos/contract/configuration";
import { configRegister, rowRefusal } from "@shared/config-registers";
import { ASSET_STATUS } from "@shared/changeset";
import { readDashboardConfig } from "@shared/dashboard";
import { cardIcons } from "../worker/site-icons";
import {
  SHOWN_ON,
  readSiteDisplay,
  shownOnChange,
  siteDisplayChange,
  siteIconAddresses,
  siteShownOn,
  siteSwitchesSet,
  sitesShownOn,
} from "@shared/site-display";

const site = (id: string, status: string) => ({ id, status });

describe("siteShownOn", () => {
  it("shows an asset of every stage but retired everywhere, and a retired one nowhere", () => {
    for (const status of ASSET_STATUS) {
      const on = status !== "retired";
      expect(siteShownOn(site("a.example", status), undefined), status).toEqual({ list: on, tv: on, work: on });
    }
  });

  it("reads a switch the operator set over the stage, one switch at a time", () => {
    const display = { "a.example": { tv: false }, "b.example": { list: true } };
    expect(siteShownOn(site("a.example", "live"), display)).toEqual({ list: true, tv: false, work: true });
    expect(siteShownOn(site("b.example", "retired"), display)).toEqual({ list: false, tv: false, work: false });
    expect(siteSwitchesSet(site("b.example", "retired"), display)).toEqual({ list: true });
  });

  it("brings a retired asset back everywhere when it is restored, when no switch was set", () => {
    expect(siteShownOn(site("a.example", "retired"), {})).toEqual({ list: false, tv: false, work: false });
    expect(siteShownOn(site("a.example", "live"), {})).toEqual({ list: true, tv: true, work: true });
  });

  it("keeps a hand-set switch through a stage move both ways", () => {
    const display = { "a.example": { tv: true, list: true, work: true } };
    expect(siteShownOn(site("a.example", "retired"), display)).toEqual({ list: false, tv: false, work: false });
    expect(siteShownOn(site("a.example", "live"), display).tv).toBe(true);
    const off = { "a.example": { list: false } };
    expect(siteShownOn(site("a.example", "live"), off).list).toBe(false);
  });

  it("narrows a list of assets to one surface, in the order given", () => {
    const sites = [site("c.example", "live"), site("a.example", "retired"), site("b.example", "live")];
    expect(sitesShownOn(sites, { "b.example": { tv: false } }, "tv").map((s) => s.id)).toEqual(["c.example"]);
    expect(sitesShownOn(sites, undefined, "list").map((s) => s.id)).toEqual(["c.example", "b.example"]);
  });
});

describe("readSiteDisplay", () => {
  it("reads absent and null as nothing saved, and an empty map as saved", () => {
    expect(readSiteDisplay(undefined)).toBeUndefined();
    expect(readSiteDisplay(null)).toBeUndefined();
    expect(readSiteDisplay({})).toEqual({});
  });

  it("refuses anything but assets of true-or-false switches, naming where", () => {
    expect(() => readSiteDisplay([])).toThrow(/must be an object/u);
    expect(() => readSiteDisplay({ "a.example": true })).toThrow(/sites\.a\.example must be an object/u);
    expect(() => readSiteDisplay({ "a.example": { tv: "no" } })).toThrow(/must be true or false/u);
    expect(() => readSiteDisplay({ "a.example": { wall: false } })).toThrow(new RegExp(SHOWN_ON.join(", ")));
  });

  it("reads an asset's icon addresses beside its switches, and refuses one that is not text", () => {
    const row = { tv: false, lightIcon: "https://cdn.example.com/a.svg", darkIcon: "https://cdn.example.com/a-dark.png" };
    expect(readSiteDisplay({ "a.example": row })).toEqual({ "a.example": row });
    expect(siteIconAddresses({ "a.example": row }, "a.example")).toEqual({ light: row.lightIcon, dark: row.darkIcon });
    expect(siteIconAddresses({ "a.example": { tv: false } }, "a.example")).toEqual({});
    expect(siteIconAddresses(undefined, "a.example")).toEqual({});
    expect(() => readSiteDisplay({ "a.example": { darkIcon: true } })).toThrow(/sites\.a\.example\.darkIcon must be an address/u);
  });

  it("is one part of config/tower.json: a broken map is refused alone, the layout and countdown still read", () => {
    const read = readDashboardConfig({ countdown: { emoji: "🌁", label: "Trip", targetAt: "2026-11-16T08:00:00.000Z" }, sites: { "a.example": { tv: 1 } } });
    expect(read.countdown?.label).toBe("Trip");
    expect(read.sites).toBeUndefined();
    expect(read.refused?.sites?.reason).toMatch(/true or false/u);
    expect(readDashboardConfig({ sites: { "a.example": { tv: false } } }).sites).toEqual({ "a.example": { tv: false } });
  });
});

describe("shownOnChange", () => {
  it("inserts the whole map when none is saved, and Undo deletes exactly it", () => {
    expect(shownOnChange(undefined, "a.example", "tv", false)).toEqual({
      ops: [{ kind: "file-json-insert", file: "config/tower.json", pointer: "/sites", value: { "a.example": { tv: false } } }],
      undo: [{ kind: "file-json-delete", file: "config/tower.json", pointer: "/sites", expect: { "a.example": { tv: false } } }],
    });
  });

  it("inserts the asset's row when it has none", () => {
    expect(shownOnChange({ "b.example": { list: false } }, "a.example", "work", false)).toEqual({
      ops: [{ kind: "file-json-insert", file: "config/tower.json", pointer: "/sites/a.example", value: { work: false } }],
      undo: [{ kind: "file-json-delete", file: "config/tower.json", pointer: "/sites/a.example", expect: { work: false } }],
    });
  });

  it("writes a key for the first time, and Undo takes the key away", () => {
    expect(shownOnChange({ "a.example": { tv: false } }, "a.example", "list", true)).toEqual({
      ops: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/sites/a.example/list", expectAbsent: true, value: true }],
      undo: [{ kind: "file-json-delete", file: "config/tower.json", pointer: "/sites/a.example/list", expect: true }],
    });
  });

  it("sets a key over the value the page read, and Undo sets it back", () => {
    expect(shownOnChange({ "a.example": { tv: false } }, "a.example", "tv", true)).toEqual({
      ops: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/sites/a.example/tv", expect: false, value: true }],
      undo: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/sites/a.example/tv", expect: true, value: false }],
    });
  });
});

describe("siteDisplayChange, for an icon address", () => {
  const URL_A = "https://cdn.example.com/a.svg";

  it("writes an address the way a switch is written, guarded by the map as read", () => {
    expect(siteDisplayChange(undefined, "a.example", "lightIcon", URL_A).ops).toEqual([
      { kind: "file-json-insert", file: "config/tower.json", pointer: "/sites", value: { "a.example": { lightIcon: URL_A } } },
    ]);
    expect(siteDisplayChange({ "a.example": { tv: false } }, "a.example", "darkIcon", URL_A)).toEqual({
      ops: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/sites/a.example/darkIcon", expectAbsent: true, value: URL_A }],
      undo: [{ kind: "file-json-delete", file: "config/tower.json", pointer: "/sites/a.example/darkIcon", expect: URL_A }],
    });
  });

  it("clears an address by deleting its key, and Undo writes it back", () => {
    expect(siteDisplayChange({ "a.example": { lightIcon: URL_A } }, "a.example", "lightIcon", null)).toEqual({
      ops: [{ kind: "file-json-delete", file: "config/tower.json", pointer: "/sites/a.example/lightIcon", expect: URL_A }],
      undo: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/sites/a.example/lightIcon", expectAbsent: true, value: URL_A }],
    });
    expect(siteDisplayChange(undefined, "a.example", "lightIcon", null)).toEqual({ ops: [], undo: [] });
  });
});

describe("cardIcons, the one place an address set here wins", () => {
  const READ = { light: "https://a.example/icon.png", dark: null, readAt: "2026-10-17T04:00:00.000Z", outcome: "read" as const, unreachableAt: null };

  it("draws a set address over the read one, scheme by scheme", () => {
    expect(cardIcons(READ, { dark: "https://cdn.example.com/a-white.svg" })).toEqual({
      light: READ.light,
      dark: "https://cdn.example.com/a-white.svg",
      readAt: READ.readAt,
      outcome: "read",
      read: { light: READ.light, dark: null },
    });
    expect(cardIcons(undefined, {})).toBeNull();
  });

  it("draws no address the register's own rule refuses, whatever route it reached the store by", () => {
    expect(cardIcons(READ, { light: "javascript:alert(1)", dark: `https://cdn.example.com/${"a".repeat(2048)}` })).toMatchObject({
      light: READ.light,
      dark: null,
    });
    expect(cardIcons(undefined, { light: "icon.png" })).toBeNull();
  });
});


describe("asset types", () => {
  it("defaults older assets to website without rewriting their settings", () => {
    expect(assetTypeOf(undefined)).toBe("website");
    const unset = readSiteDisplay({ "a.example": { assetType: null } });
    expect(assetTypeOf(unset?.["a.example"])).toBe("website");
    expect(siteDisplayChange(unset, "a.example", "assetType", "web-app").ops).toEqual([
      { kind: "file-json-set", file: "config/tower.json", pointer: "/sites/a.example/assetType", expect: null, value: "web-app" },
    ]);
    expect(assetTypeOf(readSiteDisplay({ "a.example": { tv: false } })?.["a.example"])).toBe("website");
  });

  it("round-trips each supported type beside switches and icons through both validators", () => {
    for (const assetType of ASSET_TYPES) {
      const row = { assetType, tv: false, lightIcon: "https://example.com/icon.svg" };
      const parsed = readSiteDisplay({ "a.example": row });
      expect(parsed?.["a.example"]).toEqual(row);
      expect(assetTypeOf(parsed?.["a.example"])).toBe(assetType);
      expect(rowRefusal(configRegister("site-display"), row)).toBeNull();
      expect(siteShownOn(site("a.example", "live"), parsed)).toEqual({ list: true, tv: false, work: true });
    }
    for (const assetType of ["unknown", "", 42]) {
      expect(() => readSiteDisplay({ "a.example": { assetType } })).toThrow(/assetType must be one of/);
      expect(rowRefusal(configRegister("site-display"), { assetType })).not.toBeNull();
    }
  });
});
