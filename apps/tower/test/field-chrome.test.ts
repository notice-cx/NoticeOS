// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fieldClass } from "../src/components/ui/field";
import { typeScriptSources, withoutComments } from "./source-files";

/**
 * One field box, not literal copies. The guard reads the source rather than a
 * render: a copy that agrees today passes every rendered assertion.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const OWNER = path.join("components", "ui", "field.ts");

/** Comments are not the thing under guard. */

describe("the desk's field chrome has one owner", () => {
  it("declares the box the phone floor and the disabled dim ride on", () => {
    // Not a snapshot of the whole string: the parts a copy must not drop.
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
    // The guard is on the shape, not the exact string. A field box is the
    // only thing in this app that is a rounded, bordered, `bg-background` box
    // with a focus ring; the read-only `<code>` boxes beside it have no ring,
    // and the containers that share the surface have no ring either.
    const offenders = typeScriptSources(SRC).filter((file) => {
      if (file.endsWith(OWNER)) return false;
      const source = withoutComments(readFileSync(file, "utf8"));
      return [...source.matchAll(/"[^"\n]*"/g)].some((literal) => {
        const text = literal[0];
        // No radius in the predicate: a square field is still a field. The
        // box is the border + surface + ring; the corner is a variation of it.
        return (
          (text.includes("border-border") || text.includes("border-input")) &&
          text.includes("bg-background") &&
          text.includes("focus-visible:ring-ring")
        );
      });
    });

    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("is read by the surfaces that draw a field", () => {
    // Not a closed list: a new surface with a field needs no edit here.
    const carriers = [
      "components/AddSite.tsx",
      "components/CollectionEditor.tsx",
      "components/DashboardWidgets.tsx",
      "components/FlagActions.tsx",
      "components/KnobEditor.tsx",
      "components/ProviderCard.tsx",
      "components/TaskComposer.tsx",
      "routes/AlertsRoute.tsx",
      // The asset page's two fields live in the lifecycle editor and the
      // Delete confirmation; the entry follows the code rather than the filename.
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
