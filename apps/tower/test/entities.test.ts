// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  entityAssets,
  entityLabel,
  entityMoveOps,
  entityOfAsset,
  entityReleaseOp,
  type EntityRow,
} from "@shared/entities";
// The write pipeline itself, so "the ops a move sends" is checked against the
// rules that will actually judge them rather than against this module's own
// idea of them (the same reason `asset-detail-route.test.tsx` reaches for it).
// Plain ESM with no `node:` imports, which is why it is safe from jsdom.
import { validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";

// WHICH ENTITY OWNS AN ASSET (bead `ro-aodz`).
//
// The fact is an EDGE stored once, on the entity: a row owns a list of asset
// ids, and an asset's owner is read back out of those lists. That direction is
// what makes a move two ops instead of one, and it is why this file exists —
// the three surfaces that show ownership (`/settings`, an asset's Identity
// card, the add-asset wizard) all ask these functions, so a rule proved here is
// proved for all three.

const ROWS: EntityRow[] = [
  {
    slug: "reindex-ventures",
    name: "Reindex Ventures LLC",
    form: "LLC",
    jurisdiction: "US-DE",
    assets: ["meals.example", "nosh.example"],
  },
  // Declared and owning nothing — no `assets` key at all, which is a different
  // state from `[]` and decides whether a first asset is a first write.
  { slug: "second-co", name: "Second Co" },
  // Owned something once and does not now.
  { slug: "third-co", name: "Third Co", assets: [] },
];

describe("reading who owns what", () => {
  it("finds the entity holding an asset, and answers null for one nobody claims", () => {
    expect(entityOfAsset(ROWS, "nosh.example")?.slug).toBe("reindex-ventures");
    expect(entityOfAsset(ROWS, "areas.example")).toBeNull();
    // Absence of the whole list is "nothing answered", not "nobody owns it" —
    // and the caller renders those two differently.
    expect(entityOfAsset(undefined, "nosh.example")).toBeNull();
  });

  it("reads an absent asset list as an empty one, however the file spells it", () => {
    expect(entityAssets(ROWS[0])).toEqual(["meals.example", "nosh.example"]);
    expect(entityAssets(ROWS[1])).toEqual([]);
    expect(entityAssets(ROWS[2])).toEqual([]);
    expect(entityAssets(null)).toEqual([]);
  });

  it("names an entity with the paperwork behind it, and without when there is none", () => {
    expect(entityLabel(ROWS[0] as EntityRow)).toBe("Reindex Ventures LLC · LLC, US-DE");
    expect(entityLabel(ROWS[1] as EntityRow)).toBe("Second Co");
    expect(entityLabel({ slug: "x", name: "X Co", form: "Ltd" })).toBe("X Co · Ltd");
  });
});

describe("moving one asset between entities", () => {
  /** Every op a move sends, as a changeset the pipeline would be handed. If
   * these stop being legal, a Save starts failing at the door. */
  function assertLegal(ops: unknown[]) {
    validateSchemaAndSafety({
      version: 1,
      slug: "entity-owner",
      createdAt: "2026-09-05T12:00:00.000Z",
      ops,
    });
  }

  it("takes the asset off the old list and puts it on the new one, in one changeset", () => {
    const ops = entityMoveOps(ROWS, "nosh.example", "third-co");
    expect(ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meals.example", "nosh.example"],
        value: ["meals.example"],
      },
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/2/assets",
        expect: [],
        value: ["nosh.example"],
      },
    ]);
    assertLegal(ops);
  });

  it("writes a FIRST write onto an entity that has never owned anything", () => {
    const ops = entityMoveOps(ROWS, "nosh.example", "second-co");
    expect(ops[1]).toEqual({
      kind: "file-json-set",
      file: "config/entities.json",
      pointer: "/entities/1/assets",
      expectAbsent: true,
      value: ["nosh.example"],
    });
    assertLegal(ops);
  });

  it("sends one op when the asset had no owner", () => {
    const ops = entityMoveOps(ROWS, "areas.example", "reindex-ventures");
    expect(ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meals.example", "nosh.example"],
        value: ["meals.example", "nosh.example", "areas.example"],
      },
    ]);
    assertLegal(ops);
  });

  it("sends one op when the asset is going to nobody", () => {
    const ops = entityMoveOps(ROWS, "meals.example", null);
    expect(ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meals.example", "nosh.example"],
        value: ["nosh.example"],
      },
    ]);
    assertLegal(ops);
  });

  it("writes nothing when the entity picked is the one that already owns it", () => {
    expect(entityMoveOps(ROWS, "nosh.example", "reindex-ventures")).toEqual([]);
    // And nothing when an unowned asset is left unowned.
    expect(entityMoveOps(ROWS, "areas.example", null)).toEqual([]);
  });

  it("writes nothing for an entity the list does not have", () => {
    expect(entityMoveOps(ROWS, "areas.example", "no-such-entity")).toEqual([]);
  });

  // A DELETE NEEDS THE WAY OFF ON ITS OWN (bead `ro-xzxg`). An asset that is
  // going away is moving to nobody, and its id is a string on another row's
  // list — so the op is a guarded set, never a delete: the entity outlives it.
  describe("releasing an asset nothing owns any more", () => {
    it("writes the owner's list back without the asset, and nothing else", () => {
      const op = entityReleaseOp(ROWS, "meals.example")!;
      expect(op).toEqual({
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meals.example", "nosh.example"],
        value: ["nosh.example"],
      });
      assertLegal([op]);
      // It is the same op a move to nobody sends, because it IS that op.
      expect(entityMoveOps(ROWS, "meals.example", null)).toEqual([op]);
    });

    it("answers null for an asset nobody has claimed", () => {
      expect(entityReleaseOp(ROWS, "areas.example")).toBeNull();
      expect(entityReleaseOp([], "meals.example")).toBeNull();
    });

    it("leaves the ownership map naming only what is left", () => {
      // What /settings reads after the delete lands: the deleted asset has no
      // owner to draw, and the entity's other asset is still owned by it.
      const after = ROWS.map((row) =>
        row.slug === "reindex-ventures" ? { ...row, assets: ["nosh.example"] } : row,
      );
      expect(entityOfAsset(after, "meals.example")).toBeNull();
      expect(entityAssets(after[0])).toEqual(["nosh.example"]);
    });
  });
});
