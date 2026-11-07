// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fieldClass } from "../src/components/ui/field";

describe("shared field layout", () => {
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
});
