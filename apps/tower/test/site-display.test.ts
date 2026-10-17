// Where each site shows is read in one place: a switch the operator set wins,
// and a switch nobody set follows the site's stage, so a retired site shows
// nowhere until somebody turns one on and a stage move never rewrites a
// switch. The write that flips one switch is the narrowest the stored map
// allows, and its Undo is its exact reverse.

import { describe, expect, it } from "vitest";
import { ASSET_STATUS } from "@shared/changeset";
import { readDashboardConfig } from "@shared/dashboard";
import {
  SHOWN_ON,
  readSiteDisplay,
  shownOnChange,
  siteShownOn,
  siteSwitchesSet,
  sitesShownOn,
} from "@shared/site-display";

const site = (id: string, status: string) => ({ id, status });

describe("siteShownOn", () => {
  it("shows a site of every stage but retired everywhere, and a retired one nowhere", () => {
    for (const status of ASSET_STATUS) {
      const on = status !== "retired";
      expect(siteShownOn(site("a.example", status), undefined), status).toEqual({ list: on, tv: on, work: on });
    }
  });

  it("reads a switch the operator set over the stage, one switch at a time", () => {
    const display = { "a.example": { tv: false }, "b.example": { list: true } };
    expect(siteShownOn(site("a.example", "live"), display)).toEqual({ list: true, tv: false, work: true });
    expect(siteShownOn(site("b.example", "retired"), display)).toEqual({ list: true, tv: false, work: false });
    expect(siteSwitchesSet(site("b.example", "retired"), display)).toEqual({ list: true });
  });

  it("brings a retired site back everywhere when it is restored, when no switch was set", () => {
    expect(siteShownOn(site("a.example", "retired"), {})).toEqual({ list: false, tv: false, work: false });
    expect(siteShownOn(site("a.example", "live"), {})).toEqual({ list: true, tv: true, work: true });
  });

  it("keeps a hand-set switch through a stage move both ways", () => {
    const display = { "a.example": { tv: true } };
    expect(siteShownOn(site("a.example", "retired"), display).tv).toBe(true);
    expect(siteShownOn(site("a.example", "live"), display).tv).toBe(true);
    const off = { "a.example": { list: false } };
    expect(siteShownOn(site("a.example", "live"), off).list).toBe(false);
  });

  it("narrows a list of sites to one surface, in the order given", () => {
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

  it("refuses anything but sites of true-or-false switches, naming where", () => {
    expect(() => readSiteDisplay([])).toThrow(/must be an object/u);
    expect(() => readSiteDisplay({ "a.example": true })).toThrow(/sites\.a\.example must be an object/u);
    expect(() => readSiteDisplay({ "a.example": { tv: "no" } })).toThrow(/must be true or false/u);
    expect(() => readSiteDisplay({ "a.example": { wall: false } })).toThrow(new RegExp(SHOWN_ON.join(", ")));
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

  it("inserts the site's row when it has none", () => {
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
