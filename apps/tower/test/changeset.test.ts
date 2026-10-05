import { describe, expect, it } from "vitest";
import {
  buildChangeset,
  changesetSlug,
  defaultSlug,
  resolvePointer,
  toPointer,
  type ChangesetOp,
} from "@shared/changeset";

describe("resolvePointer (RFC 6901)", () => {
  const doc = {
    flag_defaults: { alpha: 0.01, min_baseline_per_day: 3 },
    list: [{ url: "https://a.test" }, { url: "https://b.test" }],
    "a/b": 1,
    "m~n": 2,
  };

  it("resolves object + array paths", () => {
    expect(resolvePointer(doc, "/flag_defaults/alpha")).toBe(0.01);
    expect(resolvePointer(doc, "/list/1/url")).toBe("https://b.test");
  });

  it("returns the whole document for the empty pointer", () => {
    expect(resolvePointer(doc, "")).toBe(doc);
  });

  it("returns undefined for an absent segment (distinct from present null)", () => {
    expect(resolvePointer(doc, "/flag_defaults/nope")).toBeUndefined();
    expect(resolvePointer(doc, "/list/9")).toBeUndefined();
    expect(resolvePointer({ x: null }, "/x")).toBeNull();
  });

  it("decodes ~1 (/) and ~0 (~) escapes", () => {
    expect(resolvePointer(doc, "/a~1b")).toBe(1);
    expect(resolvePointer(doc, "/m~0n")).toBe(2);
  });

  it("toPointer round-trips through resolvePointer, escaping specials", () => {
    expect(toPointer(["flag_defaults", "alpha"])).toBe("/flag_defaults/alpha");
    expect(toPointer([0, "url"])).toBe("/0/url");
    expect(resolvePointer(doc, toPointer(["a/b"]))).toBe(1);
  });
});

describe("buildChangeset serializer", () => {
  const ops: ChangesetOp[] = [
    { kind: "file-json-set", file: "config/constants.json", pointer: "/flag_defaults/alpha", expect: 0.01, value: 0.02 },
    { kind: "store-asset-set", asset: "nosh.example", column: "sense_only", expect: 1, value: 0 },
  ];

  it("wraps ops in a version-1 document with the given slug + createdAt", () => {
    const cs = buildChangeset(ops, { slug: "raise-alpha", createdAt: "2026-07-06T00:00:00.000Z" });
    expect(cs.version).toBe(1);
    expect(cs.slug).toBe("raise-alpha");
    expect(cs.createdAt).toBe("2026-07-06T00:00:00.000Z");
    expect(cs.ops).toEqual(ops);
  });

  it("defaults to a kebab tower-slug derived from the timestamp", () => {
    const cs = buildChangeset(ops, { createdAt: "2026-07-06T13:04:05.000Z" });
    expect(cs.slug).toBe("tower-20260706-130405");
    expect(cs.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/); // kebab, CLI-accepted
  });

  // A SLUG THE PIPELINE ACCEPTS, out of words no surface can choose (bead
  // `ro-6ygn`). An asset id is domain-shaped and a declared field is camelCase,
  // and `validateSchemaAndSafety` wants kebab-case — so interpolating them
  // refused every Save on an asset's Sources tab for its filename.
  it("changesetSlug is kebab-case, and readable", () => {
    expect(changesetSlug("meals.example", "ga4", "propertyId")).toBe(
      "meals-example-ga4-property-id",
    );
    expect(changesetSlug("nosh.example", "dataforseo", "locationCode")).toBe(
      "nosh-example-dataforseo-location-code",
    );
    // A slug is an archive filename and a commit subject, so it may never be
    // empty — parts with nothing alphanumeric in them answer the lane's default.
    expect(changesetSlug("...", "—")).toBe("config-change");
    for (const parts of [
      ["meals.example", "ga4", "propertyId"],
      ["pacer.example", "gsc", "siteUrl"],
      ["fees.example", "bing-webmaster", "status"],
      ["...", "—"],
    ]) {
      expect(changesetSlug(...parts)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("defaultSlug is UTC and zero-padded", () => {
    expect(defaultSlug(new Date("2026-01-02T03:04:05.000Z"))).toBe("tower-20260102-030405");
  });
});
