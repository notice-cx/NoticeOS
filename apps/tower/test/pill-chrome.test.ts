// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pillChoiceClass, pillChoiceStateClass, pillClass, pillControlClass, pillPickerStateClass } from "../src/components/ui/pill";

describe("shared toggle-pill layout", () => {
  it("declares the contract, the box and both pressed pairs", () => {
    // Not a snapshot of the strings: each of these is one a hand-rolled copy
    // missed.
    for (const utility of ["outline-none", "max-sm:min-h-11", "focus-visible:ring-ring"]) {
      expect(pillControlClass).toContain(utility);
    }
    for (const utility of ["inline-flex", "rounded-md", "border", "text-xs"]) {
      expect(pillClass).toContain(utility);
    }
    // A picker hides the unpicked border; a choice keeps every border and
    // fills the chosen one. Two dialects, told apart here.
    expect(pillPickerStateClass(true)).toContain("border-primary/30");
    expect(pillPickerStateClass(false)).toContain("border-transparent");
    expect(pillChoiceStateClass(true)).toContain("bg-panel");
    expect(pillChoiceStateClass(false)).toContain("border-transparent");
    // The choice box is composed from the two above, so the shape it
    // overrides resolves rather than doubling: one radius, one horizontal padding.
    const choice = pillChoiceClass.split(/\s+/);
    expect(choice).toContain("rounded-md");
    expect(choice).not.toContain("rounded-full");
    expect(choice).toContain("px-2.25");
    expect(choice).not.toContain("px-2");
    expect(choice).toContain("max-sm:min-h-11");
  });
});
