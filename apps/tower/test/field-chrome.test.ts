import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fieldClass } from "../src/components/ui/field";

/**
 * ONE FIELD BOX, NOT TWENTY-EIGHT (bead `ro-2qc6`).
 *
 * The desk's input/select chrome existed as ~28 literal copies across 13 files,
 * three of them as a route-local `SELECT_CLASS` whose comment claimed it was
 * "the same string /alerts, /assets and /settings carry". That claim was true
 * and unenforced, which is why bead `ro-md80` had to add the phone thumb floor
 * to all of them at once by scripted replace: editing some and not others would
 * have left the desk with two field heights on a phone.
 *
 * The guard reads the SOURCE rather than a render, for the same reason
 * `collection-editor.test.tsx` does: a copy that happens to agree on the day it
 * is written passes every rendered assertion there is, and diverges on the next
 * utility somebody adds to one of them.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const OWNER = path.join("components", "ui", "field.ts");

/** Comments say the same words as code and are not the thing under guard. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every `.ts`/`.tsx` under a directory, absolute. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("the desk's field chrome has one owner", () => {
  it("declares the box the phone floor and the disabled dim ride on", () => {
    // Not a snapshot of the whole string — the point is that these four
    // survive a later edit, since each was missing from at least one copy.
    for (const utility of [
      "border-input",
      "bg-background",
      "max-sm:min-h-11",
      "disabled:opacity-60",
      "focus-visible:ring-ring",
    ]) {
      expect(fieldClass).toContain(utility);
    }
  });

  it("holds the chrome nowhere else in src/", () => {
    // The guard is on the SHAPE, not on the exact string: a copy that reorders
    // the utilities, drops the phone floor, or swaps `text-sm` for `text-xs` is
    // the same defect wearing a disguise. A field box is the only thing in this
    // app that is a rounded, bordered, `bg-background` box with a focus ring —
    // the read-only `<code>` boxes beside it have no ring, and the containers
    // that share the surface have no ring either.
    const offenders = sourceFiles(SRC).filter((file) => {
      if (file.endsWith(OWNER)) return false;
      const source = withoutComments(readFileSync(file, "utf8"));
      return [...source.matchAll(/"[^"\n]*"/g)].some((literal) => {
        const text = literal[0];
        // No radius in the predicate (bead `ro-o6qr`): the Wall editor's reason
        // field was the 29th copy and the only one drawn square, which is how
        // it hid from a guard that asked for `rounded-md`. The box is the
        // border + surface + ring; the corner is a variation of it.
        return (
          (text.includes("border-border") || text.includes("border-input")) &&
          text.includes("bg-background") &&
          text.includes("focus-visible:ring-ring")
        );
      });
    });

    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("is read by the surfaces that were carrying the copies", () => {
    // Not a closed list — a new surface with a field is welcome and needs no
    // edit here. What is pinned is that the thirteen files the copies lived in
    // read the declaration, so "adopted everywhere" cannot quietly become
    // "adopted where it was convenient".
    const carriers = [
      "components/AddSite.tsx",
      "components/CollectionEditor.tsx",
      "components/DashboardWidgets.tsx",
      "components/FlagActions.tsx",
      "components/KnobEditor.tsx",
      "components/ProviderCard.tsx",
      "components/TaskComposer.tsx",
      "routes/AlertsRoute.tsx",
      // `routes/AssetDetailRoute.tsx` held both of the asset page's fields
      // until the per-tab split (bead `ro-78qo.2`) moved them, unchanged, to
      // the two files that draw them: the lifecycle editor and the Delete
      // confirmation. The entry follows the code rather than the filename.
      "routes/asset-detail/SettingsTab.tsx",
      "routes/asset-detail/AssetRetirement.tsx",
      "routes/AssetsRoute.tsx",
      "routes/FinancialsRoute.tsx",
      "routes/TaskRoute.tsx",
      "routes/WallEditRoute.tsx",
      "routes/tasks/TasksBoard.tsx",
    ];

    const missing = carriers.filter(
      (file) =>
        !readFileSync(path.join(SRC, file), "utf8").includes(
          'from "@/components/ui/field"',
        ),
    );

    expect(missing).toEqual([]);
  });
});
