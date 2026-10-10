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
// rules that will actually judge them. Plain ESM with no `node:` imports, so
// it is safe from jsdom.
import { validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";

// An asset's owner is an edge stored once, on the entity: a row owns a list
// of asset ids, and an asset's owner is read back out of those lists. That
// direction is what makes a move two ops instead of one. The three surfaces
// that show ownership all ask these functions.

const ROWS: EntityRow[] = [
  {
    slug: "example-ventures",
    name: "Example Ventures LLC",
    form: "LLC",
    jurisdiction: "US-DE",
    assets: ["meadow.example", "northwind.example"],
  },
  // Declared and owning nothing: no `assets` key at all, which is a different
  // state from `[]` and decides whether a first asset is a first write.
  { slug: "second-co", name: "Second Co" },
  { slug: "third-co", name: "Third Co", assets: [] },
];

describe("reading who owns what", () => {
  it("finds the entity holding an asset, and answers null for one nobody claims", () => {
    expect(entityOfAsset(ROWS, "northwind.example")?.slug).toBe("example-ventures");
    expect(entityOfAsset(ROWS, "acorn.example")).toBeNull();
    // Absence of the whole list is "nothing answered", not "nobody owns it".
    expect(entityOfAsset(undefined, "northwind.example")).toBeNull();
  });

  it("reads an absent asset list as an empty one, however the file spells it", () => {
    expect(entityAssets(ROWS[0])).toEqual(["meadow.example", "northwind.example"]);
    expect(entityAssets(ROWS[1])).toEqual([]);
    expect(entityAssets(ROWS[2])).toEqual([]);
    expect(entityAssets(null)).toEqual([]);
  });

  it("names an entity with the paperwork behind it, and without when there is none", () => {
    expect(entityLabel(ROWS[0] as EntityRow)).toBe("Example Ventures LLC · LLC, US-DE");
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
    const ops = entityMoveOps(ROWS, "northwind.example", "third-co");
    expect(ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meadow.example", "northwind.example"],
        value: ["meadow.example"],
      },
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/2/assets",
        expect: [],
        value: ["northwind.example"],
      },
    ]);
    assertLegal(ops);
  });

  it("writes a FIRST write onto an entity that has never owned anything", () => {
    const ops = entityMoveOps(ROWS, "northwind.example", "second-co");
    expect(ops[1]).toEqual({
      kind: "file-json-set",
      file: "config/entities.json",
      pointer: "/entities/1/assets",
      expectAbsent: true,
      value: ["northwind.example"],
    });
    assertLegal(ops);
  });

  it("sends one op when the asset had no owner", () => {
    const ops = entityMoveOps(ROWS, "acorn.example", "example-ventures");
    expect(ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meadow.example", "northwind.example"],
        value: ["meadow.example", "northwind.example", "acorn.example"],
      },
    ]);
    assertLegal(ops);
  });

  it("sends one op when the asset is going to nobody", () => {
    const ops = entityMoveOps(ROWS, "meadow.example", null);
    expect(ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meadow.example", "northwind.example"],
        value: ["northwind.example"],
      },
    ]);
    assertLegal(ops);
  });

  it("writes nothing when the entity picked is the one that already owns it", () => {
    expect(entityMoveOps(ROWS, "northwind.example", "example-ventures")).toEqual([]);
    expect(entityMoveOps(ROWS, "acorn.example", null)).toEqual([]);
  });

  it("writes nothing for an entity the list does not have", () => {
    expect(entityMoveOps(ROWS, "acorn.example", "no-such-entity")).toEqual([]);
  });

  // An asset that is going away is moving to nobody, and its id is a string
  // on another row's list, so the op is a guarded set, never a delete.
  describe("releasing an asset nothing owns any more", () => {
    it("writes the owner's list back without the asset, and nothing else", () => {
      const op = entityReleaseOp(ROWS, "meadow.example")!;
      expect(op).toEqual({
        kind: "file-json-set",
        file: "config/entities.json",
        pointer: "/entities/0/assets",
        expect: ["meadow.example", "northwind.example"],
        value: ["northwind.example"],
      });
      assertLegal([op]);
      expect(entityMoveOps(ROWS, "meadow.example", null)).toEqual([op]);
    });

    it("answers null for an asset nobody has claimed", () => {
      expect(entityReleaseOp(ROWS, "acorn.example")).toBeNull();
      expect(entityReleaseOp([], "meadow.example")).toBeNull();
    });

    it("leaves the ownership map naming only what is left", () => {
      const after = ROWS.map((row) =>
        row.slug === "example-ventures" ? { ...row, assets: ["northwind.example"] } : row,
      );
      expect(entityOfAsset(after, "meadow.example")).toBeNull();
      expect(entityAssets(after[0])).toEqual(["northwind.example"]);
    });
  });
});
