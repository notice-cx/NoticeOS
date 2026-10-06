// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  pillChoiceClass,
  pillChoiceStateClass,
  pillClass,
  pillControlClass,
  pillPickerStateClass,
} from "../src/components/ui/pill";
import { typeScriptSources, withoutComments } from "./source-files";

/**
 * ONE TOGGLE PILL, NOT EIGHT (bead `ro-s4rg`).
 *
 * Eight hand-rolled toggles on the desk are not `<Button>`: /settings' two
 * replay pickers, the asset wizard's choices, the /assets and /work filter
 * rows, the knob editor's segments, the lifecycle stepper's chips and the tab
 * strip. Each carried its own copy of the box, the focus ring and the phone
 * thumb floor, and the copies were kept in step BY HAND — `ro-zmyq` added the
 * floor to two of them, `ro-md80` had put it on the tab strip, and three had
 * none. The bead named six; a grep found the other two, which is the whole
 * argument for reading the source instead of trusting a list.
 *
 * The guard reads the SOURCE rather than a render, for the same reason
 * `field-chrome.test.ts` does: a copy that happens to agree on the day it is
 * written passes every rendered assertion there is, and diverges on the next
 * utility somebody adds to one of them.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const OWNER = path.join("components", "ui", "pill.ts");

/** Comments say the same words as code and are not the thing under guard. */

/** Class literals in a file, as utility TOKENS. Tokens rather than substrings
 * because `hover:bg-muted/60` contains `hover:bg-muted` and means something
 * else — the tab strip's unselected state is not the picker's. */
function classTokenSets(file: string): Set<string>[] {
  const source = withoutComments(readFileSync(file, "utf8"));
  return [...source.matchAll(/"[^"\n]*"/g)].map(
    (literal) => new Set(literal[0].slice(1, -1).split(/\s+/).filter(Boolean)),
  );
}

/** Files holding a class literal the predicate recognises. */
function offenders(matches: (set: Set<string>) => boolean): string[] {
  return typeScriptSources(SRC)
    .filter((file) => !file.endsWith(OWNER))
    .filter((file) => classTokenSets(file).some(matches))
    .map((file) => path.relative(SRC, file));
}

/** Every one of `utilities` in the same literal. */
function all(...utilities: string[]): (set: Set<string>) => boolean {
  return (set) => utilities.every((u) => set.has(u));
}

describe("the desk's toggle-pill chrome has one owner", () => {
  it("declares the contract, the box and both pressed pairs", () => {
    // Not a snapshot of the strings — the point is that these survive a later
    // edit, since each was missing from at least one of the eight copies.
    for (const utility of ["outline-none", "max-sm:min-h-11", "focus-visible:ring-ring"]) {
      expect(pillControlClass).toContain(utility);
    }
    for (const utility of ["inline-flex", "rounded-md", "border", "text-xs"]) {
      expect(pillClass).toContain(utility);
    }
    // A picker hides the unpicked border; a choice keeps every border and
    // fills the chosen one. Two dialects, told apart here so a later
    // "simplification" into one cannot pass silently.
    expect(pillPickerStateClass(true)).toContain("border-primary/30");
    expect(pillPickerStateClass(false)).toContain("border-transparent");
    expect(pillChoiceStateClass(true)).toContain("bg-accent-soft");
    expect(pillChoiceStateClass(false)).toContain("border-border");
    // The choice box is COMPOSED from the two above, so the shape it overrides
    // resolves rather than doubling: one radius, one horizontal padding.
    const choice = pillChoiceClass.split(/\s+/);
    expect(choice).toContain("rounded-full");
    expect(choice).not.toContain("rounded-md");
    expect(choice).toContain("px-2.5");
    expect(choice).not.toContain("px-2");
    expect(choice).toContain("max-sm:min-h-11");
  });

  it("holds the phone floor and the focus ring nowhere else on a pill", () => {
    // The SHAPE, not the exact string: a copy that reorders the utilities or
    // swaps the radius is the same defect wearing a disguise. What names a
    // pill and nothing else in this app is a bordered inline-flex box with a
    // LABEL INSIDE IT — horizontal padding — that takes focus. The field box is
    // not `inline-flex`; the owner chip and the command palette's rows draw no
    // border; `DataSourceIcons`' focusable source mark is a bordered
    // inline-flex box but holds an icon at a fixed size and has no padding at
    // all; and the tab strip's box now carries no ring of its own.
    expect(
      offenders(
        (set) =>
          all("inline-flex", "border", "focus-visible:ring-ring")(set) &&
          [...set].some((token) => /^px-/.test(token)),
      ),
    ).toEqual([]);
  });

  it("holds neither pressed pair anywhere else in src/", () => {
    // Each pair is pinned by the two tokens that make it that pair. The
    // stepper's `done` chip is `border-transparent bg-muted` and the tab
    // strip's unselected tab is `border-transparent … hover:bg-muted/60`;
    // neither is this, which is why the match is on tokens.
    expect(offenders(all("border-border", "bg-foreground/10"))).toEqual([]);
    expect(offenders(all("border-primary/30", "bg-accent-soft"))).toEqual([]);
    expect(offenders(all("border-transparent", "hover:bg-muted"))).toEqual([]);
    expect(offenders(all("border-foreground/25", "bg-muted"))).toEqual([]);
  });

  it("is read by the eight surfaces that were carrying the copies", () => {
    // Not a closed list — a new surface with a toggle is welcome and needs no
    // edit here. What is pinned is that the files the copies lived in read the
    // declaration, so "adopted everywhere" cannot quietly become "adopted
    // where it was convenient".
    const carriers = [
      "components/AddSite.tsx",
      "components/KnobEditor.tsx",
      "components/Stepper.tsx",
      "components/Tabs.tsx",
      "routes/AssetsRoute.tsx",
      "routes/SettingsRoute.tsx",
      "routes/tasks/TasksBoard.tsx",
    ];

    const missing = carriers.filter(
      (file) =>
        !readFileSync(path.join(SRC, file), "utf8").includes('from "@/components/ui/pill"'),
    );

    expect(missing).toEqual([]);
  });

  it("keeps the stepper's chips off the control contract", () => {
    // The one of the eight that is NOT a control: `<span>`s in an `<ol>`, with
    // nothing to press. `ro-s4rg` reads its missing phone floor as drift; it is
    // a decision, and this is where the decision is kept.
    const stepper = readFileSync(path.join(SRC, "components", "Stepper.tsx"), "utf8");
    expect(stepper).toContain("pillClass");
    expect(stepper).not.toContain("pillControlClass");
    expect(stepper).not.toContain("min-h-11");
  });
});
